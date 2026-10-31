"""Docker daemon 없이 실행하는 LiteLLM 배포 설정 검사.

    python3 -m unittest discover -s tests -p test_litellm_compose.py
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = {
    "LITELLM_DB_PASSWORD": "test-db-password",
    "LITELLM_MASTER_KEY": "sk-test-master",
    "LITELLM_SALT_KEY": "test-salt",
    "LITELLM_UI_PASSWORD": "test-ui-password",
    "LLM_MODEL": "openai/test-text-model",
    "LLM_API_BASE": "https://gateway.example.invalid/v1",
    "LLM_API_KEY": "test-text-key",
    "LLM_FALLBACK_MODEL": "openai/test-backup-text-model",
    "LLM_FALLBACK_API_BASE": "https://backup.example.invalid/v1",
    "LLM_FALLBACK_API_KEY": "test-text-backup-key",
    "VLM_MODEL": "openai/test-vision-model",
    "VLM_API_BASE": "https://gateway.example.invalid/v1",
    "VLM_API_KEY": "test-provider-key",
    "VLM_FALLBACK_MODEL": "openai/test-backup-vision-model",
    "VLM_FALLBACK_API_BASE": "https://backup.example.invalid/v1",
    "VLM_FALLBACK_API_KEY": "test-backup-key",
}


@unittest.skipUnless(shutil.which("docker"), "Docker Compose CLI가 필요합니다")
class LiteLLMComposeTests(unittest.TestCase):
    def render(self, values, *, use_example=False):
        # 실제 .env와 셸의 비밀값을 읽거나 테스트 출력에 포함하지 않는다.
        env = {
            key: os.environ[key]
            for key in ("PATH", "HOME", "TMPDIR", "SYSTEMROOT")
            if key in os.environ
        }
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            app_env_file = project / ".env"
            app_env_file.write_text(
                "DOCKERHUB_USER=test\nPOSTGRES_USER=odyssey\n"
                "POSTGRES_PASSWORD=test-app-password\nPOSTGRES_DB=odyssey\n"
                "REDIS_PASSWORD=test-redis-password\n"
            )
            (project / "litellm").mkdir()
            shutil.copyfile(ROOT / "litellm/config.yaml", project / "litellm/config.yaml")
            # Compose의 YAML 파서로 프록시 설정도 읽는다. LiteLLM 런타임 검사는 별도다.
            proxy_config = (ROOT / "litellm/config.yaml").read_text()
            compose_file = project / "docker-compose.yml"
            compose_file.write_text(
                (ROOT / "docker-compose.yml").read_text()
                + "\nx-litellm:\n"
                + "\n".join("  " + line for line in proxy_config.splitlines())
                + "\n"
            )
            env_file = project / "litellm/.env"
            env_text = "\n".join(f"{key}={value}" for key, value in values.items())
            if use_example:
                env_text = (ROOT / "litellm/.env.example").read_text()
                for key, value in values.items():
                    env_text = re.sub(
                        rf"^{key}=.*$", lambda match, key=key, value=value: f"{key}={value}",
                        env_text, flags=re.MULTILINE,
                    )
            env_file.write_text(env_text)
            return subprocess.run(
                [
                    "docker",
                    "compose",
                    "--project-directory",
                    str(project),
                    "--env-file",
                    str(app_env_file),
                    "--env-file",
                    str(env_file),
                    "-f",
                    str(compose_file),
                    "config",
                    "--format",
                    "json",
                ],
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )

    def test_default_ports_and_credentials_are_isolated(self):
        result = self.render(REQUIRED)
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads(result.stdout)
        self.assertEqual(config["name"], "odyssey")
        services = config["services"]
        self.assertEqual(
            set(services), {"web", "api", "postgres", "redis", "litellm", "litellm-db"}
        )
        proxy, db = services["litellm"], services["litellm-db"]
        self.assertEqual(len(proxy["ports"]), 1)
        self.assertEqual(proxy["ports"][0]["host_ip"], "127.0.0.1")
        self.assertFalse(db.get("ports"))
        for name in ("LLM_API_KEY", "LLM_FALLBACK_API_KEY", "VLM_API_KEY", "VLM_FALLBACK_API_KEY"):
            self.assertNotIn(name, db["environment"])
        self.assertNotIn("LITELLM_MASTER_KEY", db["environment"])
        for name in REQUIRED:
            self.assertNotIn(name, services["api"]["environment"])
        self.assertNotIn("test-provider-key", json.dumps(services["api"]))
        self.assertNotIn("test-backup-key", json.dumps(services["api"]))
        self.assertNotEqual(
            proxy["environment"]["DATABASE_URL"],
            services["api"]["environment"]["DATABASE_URL"],
        )
        self.assertTrue(proxy["volumes"][0]["read_only"])
        self.assertIn("litellm-pgdata", config["volumes"])
        self.assertEqual(
            config["volumes"]["litellm-pgdata"]["name"], "odyssey-litellm_litellm-pgdata"
        )

    def test_private_ip_binding_for_gpu_worker(self):
        result = self.render({**REQUIRED, "LITELLM_BIND": "10.1.1.27"})
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads(result.stdout)
        self.assertEqual(config["services"]["litellm"]["ports"][0]["host_ip"], "10.1.1.27")

    def test_switch_to_gemini_without_changing_worker_contract(self):
        values = {
            **REQUIRED,
            "VLM_MODEL": "gemini/test-vision-model",
            "VLM_API_BASE": "https://generativelanguage.googleapis.com/v1beta",
            "VLM_API_KEY": "test-google-key",
        }
        result = self.render(values)
        self.assertEqual(result.returncode, 0, result.stderr)
        services = json.loads(result.stdout)["services"]
        for name in ("VLM_MODEL", "VLM_API_BASE", "VLM_API_KEY"):
            self.assertEqual(services["litellm"]["environment"][name], values[name])
            self.assertNotIn(name, services["api"]["environment"])

    def test_example_resolves_gemini_names_and_requested_llm_model(self):
        values = {
            key: value for key, value in REQUIRED.items()
            if key not in ("LLM_MODEL", "VLM_MODEL", "VLM_API_BASE", "VLM_API_KEY")
        }
        values["GEMINI_API_KEY"] = "test-google-key"
        result = self.render(values, use_example=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        services = json.loads(result.stdout)["services"]
        env = services["litellm"]["environment"]
        self.assertEqual(env["LLM_MODEL"], "openai/gpt-5.4-mini")
        self.assertEqual(env["VLM_MODEL"], "gemini/gemini-3.8-flash")
        self.assertEqual(env["VLM_API_BASE"], "https://generativelanguage.googleapis.com/v1beta")
        self.assertEqual(env["VLM_API_KEY"], "test-google-key")
        self.assertNotIn("test-google-key", json.dumps(services["api"]))

    def test_gpu_vision_api_can_replace_gemini_without_a_google_key(self):
        values = {
            **REQUIRED,
            "VLM_MODEL": "openai/test-gpu-vision-model",
            "VLM_API_BASE": "http://gpu.example.invalid:8000/v1",
            "VLM_API_KEY": "test-gpu-key",
        }
        result = self.render(values, use_example=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        env = json.loads(result.stdout)["services"]["litellm"]["environment"]
        for name in ("VLM_MODEL", "VLM_API_BASE", "VLM_API_KEY"):
            self.assertEqual(env[name], values[name])

    def test_example_with_empty_gemini_key_stops_deployment(self):
        values = {key: value for key, value in REQUIRED.items() if key != "VLM_API_KEY"}
        result = self.render(values, use_example=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("VLM_API_KEY", result.stderr)

    def test_llm_and_vlm_have_separate_resolvable_fallback_routes(self):
        result = self.render(REQUIRED)
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads(result.stdout)
        proxy = config["x-litellm"]
        models = {item["model_name"]: item for item in proxy["model_list"]}
        self.assertEqual(len(models), 4)
        self.assertEqual(proxy["router_settings"]["fallbacks"], [
            {"odyssey-llm": ["odyssey-llm-fallback"]},
            {"odyssey-vlm": ["odyssey-vlm-fallback"]},
        ])
        allowed = proxy["litellm_settings"]["default_key_generate_params"]["models"]
        self.assertEqual(set(allowed), set(models))
        env = config["services"]["litellm"]["environment"]
        for role in ("llm", "vlm"):
            for suffix in ("", "-fallback"):
                model = models[f"odyssey-{role}{suffix}"]
                prefix = (role + suffix).replace("-", "_").upper()
                for field in ("model", "api_base", "api_key"):
                    reference = model["litellm_params"][field]
                    variable = f"{prefix}_{field.upper()}"
                    self.assertEqual(reference, f"os.environ/{variable}")
                    self.assertEqual(env[variable], REQUIRED[variable])
                if role == "vlm":
                    self.assertTrue(model["model_info"]["supports_vision"])
        self.assertFalse(proxy["general_settings"]["store_prompts_in_spend_logs"])
        self.assertTrue(proxy["litellm_settings"]["turn_off_message_logging"])

    def test_missing_or_empty_credentials_stop_deployment(self):
        for key in REQUIRED:
            for empty in (False, True):
                with self.subTest(key=key, empty=empty):
                    values = {name: value for name, value in REQUIRED.items() if name != key}
                    if empty:
                        values[key] = ""
                    result = self.render(values)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(key, result.stderr)
