"""Tests for the Bring-Your-Own-Key (BYO) multi-tenant credential layer.

These tests cover the request-scoped override mechanism added in
`app/services/byo.py` and its integration points (llm, material, task,
the FastAPI auth dependency, and on-disk secret redaction). No network is
required: every external call is either avoided or mocked.

IMPORTANT (load-time singletons): `app.config.config` reads `MPT_API_KEY` from
the environment exactly once, at import time, into `config.app["api_key"]`. To
exercise the HTTP auth path we must set the env var BEFORE importing any `app.*`
module. We therefore set it at the very top of this file, before the imports
below run.
"""

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

# --- Set the API token BEFORE importing app modules (load-time singleton). -----
# config.app["api_key"] is populated from MPT_API_KEY at import of
# app.config.config, so this must run first.
TEST_API_KEY = "test-mpt-token-byo"
os.environ["MPT_API_KEY"] = TEST_API_KEY

# add project root to python path (mirrors the existing test/ convention)
sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app.asgi import app as asgi_app  # noqa: E402
from app.config import config  # noqa: E402
from app.services import byo  # noqa: E402
from app.services import llm  # noqa: E402
from app.services import material  # noqa: E402
from app.services import task as tm  # noqa: E402


class TestBuildOverrides(unittest.TestCase):
    """byo.build_overrides maps generic BYO fields onto MPT's native keys."""

    def _params(self, **kwargs):
        from types import SimpleNamespace

        # build_overrides only uses getattr(), so a SimpleNamespace is enough and
        # keeps us decoupled from VideoParams' required fields.
        base = dict(
            llm_provider=None,
            llm_api_key=None,
            llm_base_url=None,
            llm_model_name=None,
            pexels_api_keys=None,
            pixabay_api_keys=None,
        )
        base.update(kwargs)
        return SimpleNamespace(**base)

    def test_openai_provider_maps_generic_to_provider_keys(self):
        params = self._params(
            llm_provider="openai",
            llm_api_key="sk-customer-123",
            llm_base_url="https://gw.example/v1",
            llm_model_name="gpt-4o-mini",
        )
        ov = byo.build_overrides(params)

        self.assertEqual(ov["llm_provider"], "openai")
        self.assertEqual(ov["openai_api_key"], "sk-customer-123")
        self.assertEqual(ov["openai_base_url"], "https://gw.example/v1")
        self.assertEqual(ov["openai_model_name"], "gpt-4o-mini")

    def test_provider_is_normalized_lowercase(self):
        params = self._params(llm_provider="OpenAI", llm_api_key="sk-x")
        ov = byo.build_overrides(params)
        self.assertEqual(ov["llm_provider"], "openai")
        self.assertEqual(ov["openai_api_key"], "sk-x")

    def test_other_provider_fans_out_to_its_own_key(self):
        params = self._params(llm_provider="gemini", llm_api_key="gem-key")
        ov = byo.build_overrides(params)
        self.assertEqual(ov["gemini_api_key"], "gem-key")
        self.assertNotIn("openai_api_key", ov)

    def test_stock_footage_keys_pass_through(self):
        params = self._params(
            pexels_api_keys=["pex-1", "pex-2"], pixabay_api_keys="pix-1"
        )
        ov = byo.build_overrides(params)
        self.assertEqual(ov["pexels_api_keys"], ["pex-1", "pex-2"])
        self.assertEqual(ov["pixabay_api_keys"], "pix-1")

    def test_returns_none_when_no_byo_fields(self):
        self.assertIsNone(byo.build_overrides(self._params()))


class TestCfgResolution(unittest.TestCase):
    """byo.cfg prefers overrides inside a context, falls back to config.app."""

    def setUp(self):
        self.original_app_config = dict(config.app)

    def tearDown(self):
        config.app.clear()
        config.app.update(self.original_app_config)

    def test_cfg_prefers_override_inside_context(self):
        config.app["openai_api_key"] = "server-global-key"
        token = byo.set_overrides({"openai_api_key": "tenant-key"})
        try:
            self.assertEqual(byo.cfg("openai_api_key"), "tenant-key")
        finally:
            byo.reset_overrides(token)

    def test_cfg_falls_back_to_config_app_outside_context(self):
        config.app["openai_api_key"] = "server-global-key"
        self.assertEqual(byo.cfg("openai_api_key"), "server-global-key")

    def test_cfg_falls_back_for_unset_override_key(self):
        # Override dict present but does not contain the requested key -> fall back.
        config.app["pexels_api_keys"] = ["server-pexels"]
        token = byo.set_overrides({"openai_api_key": "tenant-key"})
        try:
            self.assertEqual(byo.cfg("pexels_api_keys"), ["server-pexels"])
        finally:
            byo.reset_overrides(token)

    def test_cfg_empty_override_value_falls_back(self):
        # Empty values ("", None, [], {}) must not shadow the global config.
        config.app["openai_api_key"] = "server-global-key"
        token = byo.set_overrides({"openai_api_key": ""})
        try:
            self.assertEqual(byo.cfg("openai_api_key"), "server-global-key")
        finally:
            byo.reset_overrides(token)

    def test_cfg_returns_default_when_unset_everywhere(self):
        config.app.pop("missing_key", None)
        self.assertEqual(byo.cfg("missing_key", "fallback"), "fallback")


class TestServiceLevelResolution(unittest.TestCase):
    """The service helpers (llm._cfg, material.get_api_key) resolve BYO keys."""

    def setUp(self):
        self.original_app_config = dict(config.app)

    def tearDown(self):
        config.app.clear()
        config.app.update(self.original_app_config)

    def test_llm_cfg_resolves_per_request_openai_key(self):
        # llm imports byo.cfg as _cfg; it must see the per-request override.
        config.app["openai_api_key"] = "server-global-key"
        token = byo.set_overrides({"openai_api_key": "tenant-llm-key"})
        try:
            self.assertEqual(llm._cfg("openai_api_key"), "tenant-llm-key")
        finally:
            byo.reset_overrides(token)

    def test_material_get_api_key_resolves_per_request_pexels_key(self):
        config.app["pexels_api_keys"] = ["server-pexels"]
        token = byo.set_overrides({"pexels_api_keys": "tenant-pexels-key"})
        try:
            self.assertEqual(material.get_api_key("pexels_api_keys"), "tenant-pexels-key")
        finally:
            byo.reset_overrides(token)

    def test_material_get_api_key_falls_back_to_global(self):
        config.app["pexels_api_keys"] = ["server-pexels"]
        # No overrides active -> server key is used.
        self.assertEqual(material.get_api_key("pexels_api_keys"), "server-pexels")


class TestRedactAndScrub(unittest.TestCase):
    """byo.redact masks param secrets; byo.scrub removes active secrets from text."""

    def test_redact_masks_sensitive_fields(self):
        params = {
            "video_subject": "coffee",
            "llm_api_key": "sk-secret-abc",
            "pexels_api_keys": ["pex-secret"],
            "pixabay_api_keys": "pix-secret",
            "tts_api_key": "tts-secret",
        }
        out = byo.redact(params)
        self.assertEqual(out["video_subject"], "coffee")  # untouched
        self.assertEqual(out["llm_api_key"], "***redacted***")
        self.assertEqual(out["pexels_api_keys"], "***redacted***")
        self.assertEqual(out["pixabay_api_keys"], "***redacted***")
        self.assertEqual(out["tts_api_key"], "***redacted***")
        # original dict is not mutated (shallow copy)
        self.assertEqual(params["llm_api_key"], "sk-secret-abc")

    def test_redact_leaves_empty_secret_fields_alone(self):
        out = byo.redact({"llm_api_key": None, "pexels_api_keys": []})
        self.assertIsNone(out["llm_api_key"])
        self.assertEqual(out["pexels_api_keys"], [])

    def test_redact_passes_through_non_dict(self):
        self.assertEqual(byo.redact("not-a-dict"), "not-a-dict")

    def test_scrub_removes_active_secret_from_error_string(self):
        secret = "sk-live-do-not-leak-1234"
        token = byo.set_overrides({"openai_api_key": secret})
        try:
            err = f"Incorrect API key provided: {secret}. Check your key."
            scrubbed = byo.scrub(err)
            self.assertNotIn(secret, scrubbed)
            self.assertIn("***redacted***", scrubbed)
        finally:
            byo.reset_overrides(token)

    def test_scrub_is_noop_without_active_overrides(self):
        # No overrides installed -> nothing to scrub.
        text = "some sk-not-a-tracked-key here"
        self.assertEqual(byo.scrub(text), text)

    def test_scrub_handles_list_valued_secret(self):
        token = byo.set_overrides({"pexels_api_keys": ["pex-aaa-secret", "pex-bbb-secret"]})
        try:
            text = "rate limited for key pex-bbb-secret"
            self.assertNotIn("pex-bbb-secret", byo.scrub(text))
        finally:
            byo.reset_overrides(token)


class TestCrossTenantNoLeak(unittest.TestCase):
    """Tenant A's key must not bleed into tenant B's context."""

    def test_reset_clears_tenant_a_before_tenant_b(self):
        # Tenant A sets a key.
        token_a = byo.set_overrides({"openai_api_key": "tenant-A-key"})
        self.assertEqual(byo.cfg("openai_api_key"), "tenant-A-key")
        byo.reset_overrides(token_a)

        # Tenant B has no BYO key (overrides None) -> A's key is gone.
        token_b = byo.set_overrides(None)
        try:
            self.assertNotEqual(byo.cfg("openai_api_key"), "tenant-A-key")
        finally:
            byo.reset_overrides(token_b)

    def test_no_overrides_after_reset(self):
        token = byo.set_overrides({"openai_api_key": "tenant-A-key"})
        byo.reset_overrides(token)
        self.assertIsNone(byo.get_overrides())


class TestHttpAuth(unittest.TestCase):
    """FastAPI auth: x-api-key is enforced because MPT_API_KEY is set (top of file).

    The POST /videos handler hands the task to a background-thread task manager.
    We stub that hand-off so the auth/contract test never starts a real render.
    """

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(asgi_app)
        # Sanity: the load-time singleton must have picked up our env token.
        assert config.app.get("api_key") == TEST_API_KEY, (
            "MPT_API_KEY was not applied to config.app['api_key']; it must be set "
            "before importing app.config.config."
        )

    def _video_body(self):
        return {
            "video_subject": "coffee",
            "video_script": "A short script so the LLM is skipped.",
            "video_source": "local",
            "voice_name": "en-US-JennyNeural-Female",
            # BYO fields exercised end-to-end through the request model.
            "llm_provider": "openai",
            "llm_api_key": "sk-tenant-in-body",
            "pexels_api_keys": ["pex-tenant-key"],
        }

    def test_post_videos_401_without_token(self):
        resp = self.client.post("/api/v1/videos", json=self._video_body())
        self.assertEqual(resp.status_code, 401)

    def test_post_videos_200_with_token_and_byo_fields(self):
        with patch(
            "app.controllers.v1.video.task_manager.add_task", return_value=None
        ) as add_task:
            resp = self.client.post(
                "/api/v1/videos",
                json=self._video_body(),
                headers={"x-api-key": TEST_API_KEY},
            )
        self.assertEqual(resp.status_code, 200, resp.text)
        data = resp.json()
        self.assertEqual(data["status"], 200)
        self.assertIn("task_id", data["data"])
        # The render hand-off happened (background work was stubbed out).
        add_task.assert_called_once()

    def test_post_videos_401_with_wrong_token(self):
        resp = self.client.post(
            "/api/v1/videos",
            json=self._video_body(),
            headers={"x-api-key": "wrong-token"},
        )
        self.assertEqual(resp.status_code, 401)

    def test_get_tasks_401_without_token(self):
        resp = self.client.get(
            "/api/v1/tasks/00000000-0000-0000-0000-000000000000"
        )
        self.assertEqual(resp.status_code, 401)

    def test_get_tasks_authorized_does_not_401(self):
        resp = self.client.get(
            "/api/v1/tasks/00000000-0000-0000-0000-000000000000",
            headers={"x-api-key": TEST_API_KEY},
        )
        # Unknown task -> 404, but crucially NOT 401 (auth passed).
        self.assertNotEqual(resp.status_code, 401)
        self.assertEqual(resp.status_code, 404)


class TestSaveScriptDataRedaction(unittest.TestCase):
    """save_script_data must write a redacted params record (no raw key on disk)."""

    def test_script_json_has_no_raw_secret(self):
        import json
        import tempfile

        from app.models.schema import VideoParams

        params = VideoParams(
            video_subject="coffee",
            video_script="hello",
            llm_provider="openai",
            llm_api_key="sk-must-not-touch-disk-9999",
            pexels_api_keys=["pex-must-not-touch-disk"],
        )

        with tempfile.TemporaryDirectory() as tmp:
            task_id = "byo-redaction-task"
            task_path = Path(tmp) / task_id
            task_path.mkdir(parents=True)

            with patch("app.services.task.utils.task_dir", return_value=str(task_path)):
                tm.save_script_data(
                    task_id, "hello", ["t1", "t2"], params
                )

            script_file = task_path / "script.json"
            self.assertTrue(script_file.exists())
            raw_text = script_file.read_text(encoding="utf-8")

            # No raw secret value anywhere in the file.
            self.assertNotIn("sk-must-not-touch-disk-9999", raw_text)
            self.assertNotIn("pex-must-not-touch-disk", raw_text)

            data = json.loads(raw_text)
            self.assertEqual(data["params"]["llm_api_key"], "***redacted***")
            self.assertEqual(data["params"]["pexels_api_keys"], "***redacted***")


if __name__ == "__main__":
    unittest.main()
