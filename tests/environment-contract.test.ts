import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCandidateEnvironment,
  buildGitEnvironment,
  buildValidationEnvironment,
  buildVerifierEnvironment,
  validateProxyEnvironment,
} from "../src/process.ts";

const SYNTHETIC_CREDENTIAL = "synthetic-deepseek-credential";

describe("role-specific environment contracts", () => {
  it("builds a minimal candidate environment with validated proxy fields", () => {
    const environment = buildCandidateEnvironment({
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      HTTPS_PROXY: "https://proxy.example.invalid:8443",
      NO_PROXY: "localhost,127.0.0.1,.example.invalid",
      NODE_USE_ENV_PROXY: "1",
      OPENAI_API_KEY: "forbidden-openai-key",
      SSH_AUTH_SOCK: "/private/ssh-agent.sock",
      AWS_ACCESS_KEY_ID: "forbidden-cloud-key",
      RANDOM_HOST_VALUE: "forbidden-random-value",
    }, "DEEPSEEK_API_KEY", SYNTHETIC_CREDENTIAL);

    assert.deepEqual(environment, {
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      HTTPS_PROXY: "https://proxy.example.invalid:8443",
      NO_PROXY: "localhost,127.0.0.1,.example.invalid",
      NODE_USE_ENV_PROXY: "1",
      DEEPSEEK_API_KEY: SYNTHETIC_CREDENTIAL,
      HOME: "/home",
      DSH_HOME: "/dsh-home",
      TMPDIR: "/tmp",
      DSH_PERMISSION_MODE: "workspace-write",
    });
  });

  it("builds a verifier environment without unrelated host values", () => {
    const environment = buildVerifierEnvironment({
      PATH: "/usr/bin:/bin",
      http_proxy: "http://proxy.example.invalid:8080",
      SSH_AUTH_SOCK: "/private/ssh-agent.sock",
      OPENAI_API_KEY: "forbidden-openai-key",
    }, {
      credentialName: "DEEPSEEK_API_KEY",
      credentialValue: SYNTHETIC_CREDENTIAL,
      effort: "high",
      maxTokens: 32_768,
    });

    assert.deepEqual(environment, {
      PATH: "/usr/bin:/bin",
      http_proxy: "http://proxy.example.invalid:8080",
      DEEPSEEK_API_KEY: SYNTHETIC_CREDENTIAL,
      DEEPSEEK_EFFORT: "high",
      DEEPSEEK_MAX_TOKENS: "32768",
      PYTHONUNBUFFERED: "1",
    });
  });

  it("keeps container validation environment exact", () => {
    assert.deepEqual(buildValidationEnvironment({}), {
      HOME: "/home",
      DSH_HOME: "/dsh-home",
      TMPDIR: "/tmp",
    });
  });

  it("keeps only minimal system values for host validation", () => {
    const environment = buildValidationEnvironment({
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      HTTP_PROXY: "http://proxy.example.invalid:8080",
      HTTPS_PROXY: "https://proxy.example.invalid:8443",
      DEEPSEEK_API_KEY: SYNTHETIC_CREDENTIAL,
      SSH_AUTH_SOCK: "/private/ssh-agent.sock",
    });

    assert.deepEqual(environment, {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      HOME: "/home",
      DSH_HOME: "/dsh-home",
      TMPDIR: "/tmp",
    });
  });

  it("builds a deterministic Git environment without proxies or credentials", () => {
    const environment = buildGitEnvironment({
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      HTTP_PROXY: "http://proxy.example.invalid:8080",
      HTTPS_PROXY: "https://proxy.example.invalid:8443",
      ALL_PROXY: "http://proxy.example.invalid:8888",
      http_proxy: "http://lower.example.invalid:8080",
      https_proxy: "https://lower.example.invalid:8443",
      all_proxy: "http://lower.example.invalid:8888",
      DEEPSEEK_API_KEY: SYNTHETIC_CREDENTIAL,
      SSH_AUTH_SOCK: "/private/ssh-agent.sock",
    });

    assert.deepEqual(environment, {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      PAGER: "cat",
    });
  });
});

describe("proxy environment validation", () => {
  it("rejects uppercase and lowercase proxy forms together", () => {
    assert.throws(
      () => validateProxyEnvironment({
        HTTP_PROXY: "http://proxy.example.invalid:8080",
        http_proxy: "http://proxy.example.invalid:8080",
      }),
      (error: unknown) => {
        assert.match((error as Error).message, /proxy_environment_conflict/u);
        assert.match((error as Error).message, /HTTP_PROXY,http_proxy/u);
        assert.doesNotMatch((error as Error).message, /proxy\.example/u);
        return true;
      },
    );
  });

  it("rejects proxy URL userinfo without leaking the URL or credential", () => {
    const privateProxyUrl = "http://synthetic-user:synthetic-proxy-secret@proxy.example.invalid:8080";
    assert.throws(
      () => validateProxyEnvironment({ HTTPS_PROXY: privateProxyUrl }),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /proxy_url_contains_credentials/u);
        assert.match(message, /HTTPS_PROXY/u);
        assert.doesNotMatch(message, /synthetic-user|synthetic-proxy-secret|proxy\.example/u);
        assert.equal(message.includes(privateProxyUrl), false);
        return true;
      },
    );
  });

  it("rejects unsupported proxy URL protocols without leaking the URL", () => {
    const unsupportedProxyUrl = "ftp://private-proxy.example.invalid:21";
    assert.throws(
      () => validateProxyEnvironment({ ALL_PROXY: unsupportedProxyUrl }),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /proxy_protocol_invalid/u);
        assert.match(message, /ALL_PROXY/u);
        assert.equal(message.includes(unsupportedProxyUrl), false);
        return true;
      },
    );
  });

  it("rejects overlong proxy URLs without echoing their content", () => {
    const overlongProxyUrl = `https://${"private".repeat(400)}.example.invalid`;
    assert.throws(
      () => validateProxyEnvironment({ HTTPS_PROXY: overlongProxyUrl }),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /proxy_url_too_long/u);
        assert.match(message, /HTTPS_PROXY/u);
        assert.equal(message.includes(overlongProxyUrl), false);
        return true;
      },
    );
  });

  it("validates NO_PROXY and NODE_USE_ENV_PROXY values", () => {
    assert.deepEqual(validateProxyEnvironment({
      NO_PROXY: "localhost,127.0.0.1,.example.invalid,10.0.0.0/8",
      NODE_USE_ENV_PROXY: "1",
    }), {
      NO_PROXY: "localhost,127.0.0.1,.example.invalid,10.0.0.0/8",
      NODE_USE_ENV_PROXY: "1",
    });
    for (const invalidEnvironment of [
      { NO_PROXY: "https://private.example.invalid" },
      { NO_PROXY: "user@private.example.invalid" },
      { NODE_USE_ENV_PROXY: "true" },
    ]) {
      assert.throws(
        () => validateProxyEnvironment(invalidEnvironment),
        /proxy_environment_invalid/u,
      );
    }
  });

  it("accepts an environment with no proxy configuration", () => {
    assert.deepEqual(validateProxyEnvironment({ PATH: "/usr/bin:/bin" }), {});
  });
});
