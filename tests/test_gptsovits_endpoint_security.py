"""GPT-SoVITS outbound requests stay on loopback or explicit trusted CIDRs."""
import contextlib
import importlib
import json
import socket
import struct
import time

import pytest


@pytest.fixture
def outbound_http():
    return importlib.import_module("services.outbound_http")


def _answer(ip: str, port: int = 9880):
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    return [(family, socket.SOCK_STREAM, 6, "", (ip, port))]


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://127.0.0.1/resource",
        "http://127.0.0.1.evil.example:9880",
        "http://127.0.0.1@evil.example:9880",
        "http://user:secret@127.0.0.1:9880",
        "http://127.0.0.1:9880/admin",
        "http://127.0.0.1:9880/?next=http://169.254.169.254",
    ],
)
def test_rejects_non_origin_and_host_spoof_urls(outbound_http, monkeypatch, url):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: _answer("127.0.0.1"))
    with pytest.raises(outbound_http.UnsafeEndpoint):
        outbound_http.resolve_trusted_endpoint(url)


def test_private_network_requires_explicit_existing_trust_policy(outbound_http, monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: _answer("192.168.4.20"))
    monkeypatch.delenv("OMNIVOICE_TRUSTED_NETWORKS", raising=False)
    with pytest.raises(outbound_http.UnsafeEndpoint):
        outbound_http.resolve_trusted_endpoint("http://gptsovits.lan:9880")

    monkeypatch.setenv("OMNIVOICE_TRUSTED_NETWORKS", "192.168.4.0/24")
    endpoint = outbound_http.resolve_trusted_endpoint("http://gptsovits.lan:9880")
    assert endpoint.ip == "192.168.4.20"


def test_mixed_dns_answers_are_rejected(outbound_http, monkeypatch):
    monkeypatch.setenv("OMNIVOICE_TRUSTED_NETWORKS", "10.0.0.0/8")
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: _answer("10.2.3.4") + _answer("169.254.169.254"),
    )
    with pytest.raises(outbound_http.UnsafeEndpoint):
        outbound_http.resolve_trusted_endpoint("http://gptsovits.internal:9880")


class _Response:
    def __init__(self, status=200):
        self.status = status
        self.closed = False

    def close(self):
        self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class _Connection:
    instances = []

    def __init__(self, endpoint, timeout):
        self.endpoint = endpoint
        self.timeout = timeout
        self.request_args = None
        self.response = _Response()
        self.closed = False
        self.instances.append(self)

    def request(self, *args, **kwargs):
        self.request_args = (args, kwargs)

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


class _CaptureSocket:
    def __init__(self):
        self.chunks = []

    def sendall(self, data):
        self.chunks.append(data)


@pytest.mark.parametrize(
    ("connection_kind", "endpoint_args", "expected_host"),
    [
        (
            "http",
            ("http", "127.0.0.1", 80, "127.0.0.1"),
            b"Host: 127.0.0.1\r\n",
        ),
        (
            "http",
            ("http", "localhost", 9880, "127.0.0.1"),
            b"Host: localhost:9880\r\n",
        ),
        (
            "http",
            ("http", "::1", 9880, "::1"),
            b"Host: [::1]:9880\r\n",
        ),
        (
            "https",
            ("https", "localhost", 443, "127.0.0.1"),
            b"Host: localhost\r\n",
        ),
    ],
)
def test_http_client_builds_complete_host_authority(
    outbound_http, connection_kind, endpoint_args, expected_host
):
    connection_cls = (
        outbound_http._PinnedHTTPSConnection
        if connection_kind == "https"
        else outbound_http._PinnedHTTPConnection
    )
    endpoint = outbound_http.ResolvedEndpoint(*endpoint_args)
    connection = connection_cls(endpoint, timeout=2)
    capture = _CaptureSocket()
    connection.sock = capture

    connection.request("GET", "/")

    wire = b"".join(capture.chunks)
    assert expected_host in wire


def test_valid_endpoint_is_pinned_to_the_single_validated_dns_answer(
    outbound_http, monkeypatch
):
    calls = 0

    def changing_dns(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return _answer("127.0.0.1" if calls == 1 else "169.254.169.254")

    _Connection.instances.clear()
    monkeypatch.setattr(socket, "getaddrinfo", changing_dns)
    monkeypatch.setattr(outbound_http, "_PinnedHTTPConnection", _Connection)
    response = outbound_http.open_trusted_endpoint(
        "http://localhost:9880", method="POST", query="text=hello", timeout=5
    )

    connection = _Connection.instances[0]
    assert calls == 1
    assert connection.endpoint.ip == "127.0.0.1"
    assert connection.request_args[0] == ("POST", "/?text=hello")
    # open_trusted_endpoint now forwards body/headers explicitly even when
    # the caller didn't supply either, so http.client can attach Content-Length
    # for body-less requests without ambiguity. The defaults still mean
    # "no body, no extra headers".
    assert connection.request_args[1] == {"body": None, "headers": {}}
    assert response.status == 200


def test_redirect_is_rejected_without_following_location(outbound_http, monkeypatch):
    _Connection.instances.clear()
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: _answer("127.0.0.1"))
    monkeypatch.setattr(outbound_http, "_PinnedHTTPConnection", _Connection)
    original_init = _Connection.__init__

    def redirecting_init(self, endpoint, timeout):
        original_init(self, endpoint, timeout)
        self.response = _Response(302)

    monkeypatch.setattr(_Connection, "__init__", redirecting_init)
    with pytest.raises(outbound_http.UnsafeEndpoint, match="redirects"):
        outbound_http.open_trusted_endpoint(
            "http://127.0.0.1:9880", method="GET", timeout=2
        )
    assert _Connection.instances[0].closed is True


def test_gptsovits_availability_uses_valid_configured_endpoint(
    outbound_http, monkeypatch
):
    from services.tts_backend import GPTSoVITSBackend

    calls = []

    class _ContextResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    monkeypatch.setenv("OMNIVOICE_GPTSOVITS_URL", "http://127.0.0.1:9880")
    monkeypatch.setattr(
        outbound_http,
        "open_trusted_endpoint",
        lambda url, **kwargs: calls.append((url, kwargs)) or _ContextResponse(),
    )

    assert GPTSoVITSBackend.is_available() == (True, "ready (api_v2 server reachable)")
    # Probe targets the api_v2 /tts route — a healthy server returns 200/400/405,
    # the routing-mismatch branch is exercised separately below.
    # Only the connect to a loopback server is capped (0.3 s): Windows retries
    # a refused loopback connect for ~2 s, which /engines used to wait out.
    assert calls == [
        ("http://127.0.0.1:9880", {"method": "GET", "timeout": 2, "path": "tts", "allowed_statuses": {400, 405}, "loopback_connect_timeout": 0.3, "query": "text=&text_lang=en&prompt_lang=en"})
    ]


def test_gptsovits_routing_mismatch_message_distinguishes_old_protocol(
    outbound_http, monkeypatch
):
    """A 404 from /tts means the server is up but speaks api.py (v1), not api_v2.

    The old adapter folded this into "not reachable", so users running v1
    could not tell whether their server was stopped or just the wrong
    version (#2102).
    """
    from services.tts_backend import GPTSoVITSBackend

    def raise_404(*_args, **_kwargs):
        raise outbound_http.EndpointHTTPError(404)

    monkeypatch.setenv("OMNIVOICE_GPTSOVITS_URL", "http://127.0.0.1:9880")
    monkeypatch.setattr(outbound_http, "open_trusted_endpoint", raise_404)

    ok, message = GPTSoVITSBackend.is_available()
    assert ok is False
    assert "does not expose api_v2" in message
    assert "api_v2.py" in message
    assert "not reachable" not in message


def test_gptsovits_connection_refused_message_unchanged(outbound_http, monkeypatch):
    """A genuine connection failure still reads as 'not reachable'.

    Keeps the two failure modes visibly distinct in the UI: routing
    mismatch → wrong-protocol advice, network failure → start-server advice.
    """
    from services.tts_backend import GPTSoVITSBackend

    def raise_refused(*_args, **_kwargs):
        raise ConnectionRefusedError("endpoint returned HTTP 0 / Connection refused")

    monkeypatch.setenv("OMNIVOICE_GPTSOVITS_URL", "http://127.0.0.1:9880")
    monkeypatch.setattr(outbound_http, "open_trusted_endpoint", raise_refused)

    ok, message = GPTSoVITSBackend.is_available()
    assert ok is False
    assert "not reachable" in message
    assert "api_v2.py" in message
    assert "does not expose api_v2" not in message


@pytest.mark.parametrize("ref_text", ["reference text", None])
def test_gptsovits_generate_posts_json_to_tts_with_v2_schema(
    outbound_http, monkeypatch, ref_text
):
    """The generate path sends api_v2's JSON body to /tts, not v1's query string.

    Regression test for #2102: the adapter previously POSTed a query string
    at the origin URL with v1 field names (``text_language``, ``refer_wav_path``,
    ``prompt_language``), which api_v2 silently 404s on. The fix sends JSON
    to /tts with v2 field names (``text_lang``, ``ref_audio_path``,
    ``prompt_lang``) and the required v2-only keys (``media_type``,
    ``text_split_method``, ``streaming_mode``).
    """
    import json
    import io
    import struct

    from services.tts_backend import GPTSoVITSBackend

    # Minimal valid WAV header + 1 sample so torchaudio.load() succeeds.
    # 32 kHz mono int16 to match GPTSoVITSBackend.sample_rate so the
    # resample step is a no-op (the test focuses on the request shape,
    # not the audio math).
    riff_size = struct.pack("<I", 36 + 2)  # 36 + data payload size
    fmt_chunk = struct.pack("<IHHIIHH", 16, 1, 1, 32000, 64000, 2, 16)
    data_size = struct.pack("<I", 2)
    wav_header = b"RIFF" + riff_size + b"WAVE" + b"fmt " + fmt_chunk + b"data" + data_size + b"\x00\x00"

    class _ByteResponse:
        def __init__(self, payload):
            self._payload = payload

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return self._payload

        def close(self):
            pass

    captured = {}

    def fake_open(url, **kwargs):
        captured["url"] = url
        captured["kwargs"] = kwargs
        body = kwargs.get("body")
        if body is not None:
            captured["json"] = json.loads(body.decode("utf-8"))
        captured["content_type"] = kwargs.get("content_type")
        return _ByteResponse(wav_header)

    monkeypatch.setenv("OMNIVOICE_GPTSOVITS_URL", "http://127.0.0.1:9880")
    monkeypatch.setattr(outbound_http, "open_trusted_endpoint", fake_open)

    backend = GPTSoVITSBackend()
    backend.generate(
        "hello world",
        ref_audio="/tmp/ref.wav",
        ref_text=ref_text,
        language="en",
        speed=1.5,
    )

    # Path / method / content-type — api_v2 contract.
    assert captured["url"] == "http://127.0.0.1:9880"
    assert captured["kwargs"]["method"] == "POST"
    assert captured["kwargs"]["path"] == "tts"
    assert captured["content_type"] == "application/json"
    # v2 field names — none of the v1 names are present.
    body = captured["json"]
    assert body["text"] == "hello world"
    assert body["text_lang"] == "en"
    assert body["ref_audio_path"] == "/tmp/ref.wav"
    assert body["prompt_text"] == (ref_text or "")
    assert body["prompt_lang"] == "auto"
    # v1 names that the old adapter sent — must NOT appear anymore.
    for legacy in ("text_language", "refer_wav_path", "prompt_language"):
        assert legacy not in body, f"{legacy!r} is a v1 field, must not leak into v2"
    # v2-only keys the server requires.
    assert body["media_type"] == "wav"
    assert body["text_split_method"] == "cut0"
    assert body["streaming_mode"] is False
    # Speed forwarded as float, not stringified.
    assert body["speed_factor"] == 1.5
    assert isinstance(body["speed_factor"], float)


@pytest.mark.parametrize("reference", [None, ""])
def test_gptsovits_rejects_missing_reference_before_network(outbound_http, monkeypatch, reference):
    """api_v2 requires a reference; invalid input must not reach the server."""
    from services.tts_backend import GPTSoVITSBackend, TTSInputError

    def unexpected_request(*args, **kwargs):
        pytest.fail("Missing-reference generation made a network request")

    monkeypatch.setattr(outbound_http, "open_trusted_endpoint", unexpected_request)
    monkeypatch.delenv("OMNIVOICE_GPTSOVITS_REF_AUDIO", raising=False)
    with pytest.raises(TTSInputError, match="needs a reference clip"):
        GPTSoVITSBackend().generate("just text", ref_audio=reference)


def test_gptsovits_generate_wraps_request_errors_with_server_url(
    outbound_http, monkeypatch
):
    """The user-facing error names the configured server URL, not the path.

    VoiceStudio users typically reach the engine through Settings, where
    the URL is configurable; without the URL in the error they have to
    dig through Settings to find out which one failed. The legacy adapter
    included the URL on the success path but not on the failure path.
    """
    from services.tts_backend import GPTSoVITSBackend

    def boom(*_args, **_kwargs):
        raise OSError("endpoint returned HTTP 500")

    monkeypatch.setenv("OMNIVOICE_GPTSOVITS_URL", "http://gptsovits.lan:9880")
    monkeypatch.setattr(outbound_http, "open_trusted_endpoint", boom)

    backend = GPTSoVITSBackend()
    with pytest.raises(RuntimeError, match="gptsovits.lan:9880"):
        backend.generate("anything", ref_audio="reference.wav")


@pytest.mark.parametrize("status", [400, 405])
def test_gptsovits_probe_accepts_route_present_errors(outbound_http, monkeypatch, status):
    """Exercise the real transport boundary, not a successful helper stub."""
    from services.tts_backend import GPTSoVITSBackend

    monkeypatch.setenv("OMNIVOICE_GPTSOVITS_URL", "http://127.0.0.1:9880")
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: _answer("127.0.0.1"))
    monkeypatch.setattr(outbound_http, "_PinnedHTTPConnection", _Connection)
    monkeypatch.setattr(_Connection, "getresponse", lambda self: _Response(status))
    assert GPTSoVITSBackend.is_available() == (True, "ready (api_v2 server reachable)")


@pytest.mark.parametrize("status", [400, 401, 403, 404, 405, 500])
def test_transport_still_rejects_unapproved_http_errors(outbound_http, monkeypatch, status):
    """Generation and other callers must still fail on HTTP errors by default."""
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: _answer("127.0.0.1"))
    monkeypatch.setattr(outbound_http, "_PinnedHTTPConnection", _Connection)
    monkeypatch.setattr(_Connection, "getresponse", lambda self: _Response(status))
    with pytest.raises(OSError, match=f"HTTP {status}"):
        outbound_http.open_trusted_endpoint("http://127.0.0.1:9880", method="POST", path="tts", timeout=2)
    assert _Connection.instances[-1].closed


def test_allowed_statuses_cannot_enable_redirects(outbound_http, monkeypatch):
    """Even caller-approved redirect statuses cannot escape the pinned origin."""
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: _answer("127.0.0.1"))
    monkeypatch.setattr(outbound_http, "_PinnedHTTPConnection", _Connection)
    monkeypatch.setattr(_Connection, "getresponse", lambda self: _Response(302))
    with pytest.raises(outbound_http.UnsafeEndpoint, match="redirects"):
        outbound_http.open_trusted_endpoint("http://127.0.0.1:9880", method="GET", path="tts", timeout=2, allowed_statuses={302})
    assert _Connection.instances[-1].closed


@pytest.mark.parametrize("path", ["../control", "//evil.example/tts", "tts?command=exit"])
def test_transport_rejects_non_allowlisted_routes(outbound_http, monkeypatch, path):
    """New JSON transport support cannot select arbitrary trusted-host routes."""
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: _answer("127.0.0.1"))
    monkeypatch.setattr(outbound_http, "_PinnedHTTPConnection", _Connection)
    with pytest.raises(outbound_http.UnsafeEndpoint, match="allowlist"):
        outbound_http.open_trusted_endpoint("http://127.0.0.1:9880", method="POST", path=path, timeout=2)
    assert _Connection.instances[-1].request_args is None


def test_transport_forwards_json_bytes_and_content_headers(outbound_http, monkeypatch):
    """The actual pinned connection receives the api_v2 body unchanged."""
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: _answer("127.0.0.1"))
    monkeypatch.setattr(outbound_http, "_PinnedHTTPConnection", _Connection)
    body = b'{"text":"hello"}'
    with outbound_http.open_trusted_endpoint(
        "http://127.0.0.1:9880", method="POST", path="tts", timeout=2,
        body=body, content_type="application/json",
    ):
        pass
    assert _Connection.instances[-1].request_args == (
        ("POST", "/tts"),
        {"body": body, "headers": {"Content-Type": "application/json", "Content-Length": str(len(body))}},
    )


def test_transport_rejects_body_without_content_type(outbound_http, monkeypatch):
    """An ambiguous request body must not be sent to the configured service."""
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: _answer("127.0.0.1"))
    monkeypatch.setattr(outbound_http, "_PinnedHTTPConnection", _Connection)
    with pytest.raises(outbound_http.UnsafeEndpoint, match="Content-Type"):
        outbound_http.open_trusted_endpoint("http://127.0.0.1:9880", method="POST", path="tts", timeout=2, body=b"{}")
    assert _Connection.instances[-1].request_args is None


@pytest.mark.parametrize('status', [401, 403, 500])
def test_probe_reports_reachable_http_failures(outbound_http, monkeypatch, status):
    from services.tts_backend import GPTSoVITSBackend
    monkeypatch.setenv('OMNIVOICE_GPTSOVITS_URL', 'http://127.0.0.1:9880')
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *_a, **_k: _answer('127.0.0.1'))
    monkeypatch.setattr(outbound_http, '_PinnedHTTPConnection', _Connection)
    original_init = _Connection.__init__
    def init(self, endpoint, timeout):
        original_init(self, endpoint, timeout)
        self.response = _Response(status)
    monkeypatch.setattr(_Connection, '__init__', init)
    ok, message = GPTSoVITSBackend.is_available()
    assert not ok
    assert f'HTTP {status}' in message
    assert 'http://127.0.0.1:9880' in message
    assert 'not reachable' not in message


def test_probe_supplies_languages_without_synthesizing(outbound_http, monkeypatch):
    """api_v2 lowercases language parameters before validating a missing reference."""
    from urllib.parse import parse_qs, urlsplit
    from services.tts_backend import GPTSoVITSBackend
    monkeypatch.setenv('OMNIVOICE_GPTSOVITS_URL', 'http://127.0.0.1:9880')
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *_a, **_k: _answer('127.0.0.1'))
    class ApiV2Connection(_Connection):
        def request(self, method, target, **kwargs):
            query = parse_qs(urlsplit(target).query, keep_blank_values=True)
            try:
                for key in ('text_lang', 'prompt_lang'):
                    query.get(key, [None])[0].lower()
            except AttributeError:
                self.response = _Response(500)
                return
            assert not query.get('ref_audio_path')
            assert query['text'] == ['']
            self.response = _Response(400)
    monkeypatch.setattr(outbound_http, '_PinnedHTTPConnection', ApiV2Connection)
    assert GPTSoVITSBackend.is_available()[0]


def _fake_open(monkeypatch, outbound_http, captured):
    import json

    class _EmptyResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b""

        def close(self):
            pass

    def fake_open(url, **kwargs):
        captured["kwargs"] = kwargs
        captured["json"] = json.loads(kwargs["body"].decode("utf-8"))
        return _EmptyResponse()

    monkeypatch.setattr(outbound_http, "open_trusted_endpoint", fake_open)
    import torchaudio

    def fake_load(_buf):
        import torch
        return torch.zeros(1, 16000), 16000

    monkeypatch.setattr(torchaudio, "load", fake_load)



def test_gptsovits_generate_uses_configured_default_reference(outbound_http, monkeypatch):
    """Plain TTS clones the environment's default clip when the request has none."""
    from services.tts_backend import GPTSoVITSBackend

    captured = {}
    _fake_open(monkeypatch, outbound_http, captured)
    monkeypatch.setenv("OMNIVOICE_GPTSOVITS_URL", "http://127.0.0.1:9880")
    monkeypatch.setenv("OMNIVOICE_GPTSOVITS_REF_AUDIO", "/srv/voices/me.wav")
    monkeypatch.setenv("OMNIVOICE_GPTSOVITS_REF_TEXT", "the words in the clip")
    monkeypatch.setenv("OMNIVOICE_GPTSOVITS_REF_LANG", "ja")

    GPTSoVITSBackend().generate("just text")
    body = captured["json"]
    assert body["text"] == "just text"
    assert body["text_lang"] == "en"
    assert body["ref_audio_path"] == "/srv/voices/me.wav"
    assert body["prompt_text"] == "the words in the clip"
    assert body["prompt_lang"] == "ja"
    # An explicit clip on the request still wins over the default.
    GPTSoVITSBackend().generate("more", ref_audio="/clips/other.wav", ref_text="other words")
    assert captured["json"]["ref_audio_path"] == "/clips/other.wav"
    assert captured["json"]["prompt_lang"] == "auto"
    # No speed override means no speed_factor key at all.
    assert "speed_factor" not in captured["json"]


@pytest.mark.parametrize("target_language", ["en", "ja", "zh", "ko", "yue"])
def test_explicit_reference_language_is_independent_of_target(
    outbound_http, monkeypatch, target_language
):
    """Profile/upload references must not be phonemized in the target language."""
    from services.tts_backend import GPTSoVITSBackend
    captured = {}
    _fake_open(monkeypatch, outbound_http, captured)
    monkeypatch.setenv("OMNIVOICE_GPTSOVITS_REF_LANG", "ja")
    GPTSoVITSBackend().generate(
        "target text", language=target_language,
        ref_audio="/clips/english.wav", ref_text="An English reference.",
    )
    assert captured["json"]["text_lang"] == target_language
    assert captured["json"]["prompt_lang"] == "auto"


def test_default_reference_without_language_uses_auto(outbound_http, monkeypatch):
    from services.tts_backend import GPTSoVITSBackend
    captured = {}
    _fake_open(monkeypatch, outbound_http, captured)
    monkeypatch.setenv("OMNIVOICE_GPTSOVITS_REF_AUDIO", "/clips/english.wav")
    monkeypatch.setenv("OMNIVOICE_GPTSOVITS_REF_TEXT", "An English reference.")
    monkeypatch.delenv("OMNIVOICE_GPTSOVITS_REF_LANG", raising=False)
    GPTSoVITSBackend().generate("target text", language="ja")
    assert captured["json"]["text_lang"] == "ja"
    assert captured["json"]["prompt_lang"] == "auto"


# ── Probe latency: /engines must not wait out a closed loopback port ─────────
# Windows retries a refused loopback connect for about two seconds, and every
# engine-catalogue read probes GPT-SoVITS, so /engines took ~2.2 s on Windows
# while no server ran. The probe now caps only the loopback connect, and
# catalogue reads reuse a recent "not reachable" verdict. A started server must
# still be detected by every explicit check.


@pytest.mark.parametrize(
    ("ip", "trusted", "expected"),
    [("127.0.0.1", "", 0.3), ("::1", "", 0.3), ("192.168.4.20", "192.168.4.0/24", None)],
)
def test_connect_budget_applies_to_loopback_only(outbound_http, monkeypatch, ip, trusted, expected):
    """A LAN server may take longer to accept; it keeps the full timeout."""
    monkeypatch.setenv("OMNIVOICE_TRUSTED_NETWORKS", trusted)
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_a, **_k: _answer(ip))
    monkeypatch.setattr(outbound_http, "_PinnedHTTPConnection", _Connection)
    with outbound_http.open_trusted_endpoint(
        "http://gptsovits.local:9880", method="GET", path="tts", timeout=2,
        loopback_connect_timeout=0.3,
    ):
        pass
    assert getattr(_Connection.instances[-1], "connect_timeout", None) == expected


def test_pinned_connection_caps_the_connect_but_not_the_reads(outbound_http, monkeypatch):
    seen = []

    class _Socket:
        def settimeout(self, value):
            seen.append(("read", value))

    def create_connection(address, timeout=None, source_address=None):
        seen.append(("connect", timeout))
        return _Socket()

    monkeypatch.setattr(socket, "create_connection", create_connection)
    endpoint = outbound_http.ResolvedEndpoint("http", "127.0.0.1", 9880, "127.0.0.1")
    connection = outbound_http._PinnedHTTPConnection(endpoint, timeout=2)
    connection.connect_timeout = 0.3
    connection.connect()
    assert seen == [("connect", 0.3), ("read", 2)]


def test_closed_loopback_port_fails_fast(monkeypatch):
    from services.tts_backend import GPTSoVITSBackend

    with socket.socket() as reserved:
        # Bound but not listening, so connections to it are refused.
        reserved.bind(("127.0.0.1", 0))
        monkeypatch.setenv("OMNIVOICE_GPTSOVITS_URL", f"http://127.0.0.1:{reserved.getsockname()[1]}")
        started = time.monotonic()
        ok, message = GPTSoVITSBackend.is_available()
        elapsed = time.monotonic() - started
    assert not ok and "not reachable" in message
    assert elapsed < 1.0, f"probing a closed port took {elapsed:.2f} s"


def test_busy_loopback_server_is_still_detected(monkeypatch):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread

    from services.tts_backend import GPTSoVITSBackend

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            # api_v2 answers from an event loop that a synthesis blocks: slower
            # than the connect budget, well inside the read timeout.
            time.sleep(0.6)
            self.send_response(400)
            self.send_header("Content-Length", "0")
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setenv("OMNIVOICE_GPTSOVITS_URL", f"http://127.0.0.1:{server.server_port}")
        assert GPTSoVITSBackend.is_available() == (True, "ready (api_v2 server reachable)")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class _Server:
    """``open_trusted_endpoint`` double for a GPT-SoVITS server started later."""

    def __init__(self):
        self.running = False
        self.probes = 0

    def __call__(self, url, **kwargs):
        self.probes += 1
        if not self.running:
            raise ConnectionRefusedError("connection refused")
        return contextlib.nullcontext()


@pytest.fixture
def server(outbound_http, monkeypatch):
    from services import tts_backend

    monkeypatch.setenv("OMNIVOICE_GPTSOVITS_URL", "http://127.0.0.1:9880")
    monkeypatch.setattr(tts_backend, "active_backend_id", lambda: "omnivoice")
    double = _Server()
    monkeypatch.setattr(outbound_http, "open_trusted_endpoint", double)
    return double


def test_catalogue_reads_reuse_a_recent_unreachable_verdict(server):
    from services import tts_backend

    with tts_backend.catalogue_read():
        assert tts_backend.GPTSoVITSBackend.is_available()[0] is False
        assert tts_backend.GPTSoVITSBackend.is_available()[0] is False
    assert server.probes == 1


def test_started_server_is_detected_by_explicit_checks(server):
    """Selecting the engine, Test engine and generation never reuse a verdict."""
    from services import tts_backend

    backend = tts_backend.GPTSoVITSBackend
    with tts_backend.catalogue_read():
        assert backend.is_available()[0] is False
    server.running = True
    assert backend.is_available() == (True, "ready (api_v2 server reachable)")
    # The fresh answer replaces the remembered verdict for catalogue reads too.
    with tts_backend.catalogue_read():
        assert backend.is_available()[0] is True
    assert server.probes == 3


def test_selected_engine_is_probed_on_every_catalogue_read(server, monkeypatch):
    """The composer polls /engines while its engine is down and must unlock promptly."""
    from services import tts_backend

    monkeypatch.setattr(tts_backend, "active_backend_id", lambda: "gpt-sovits")
    with tts_backend.catalogue_read():
        assert tts_backend.GPTSoVITSBackend.is_available()[0] is False
        server.running = True
        assert tts_backend.GPTSoVITSBackend.is_available()[0] is True
    assert server.probes == 2


def test_remembered_verdict_expires(server):
    from services import tts_backend

    url = "http://127.0.0.1:9880"
    with tts_backend.catalogue_read():
        tts_backend.GPTSoVITSBackend.is_available()
        _expiry, message = tts_backend._UNREACHABLE_SERVERS[url]
        tts_backend._UNREACHABLE_SERVERS[url] = (time.monotonic() - 1, message)
        server.running = True
        assert tts_backend.GPTSoVITSBackend.is_available()[0] is True
    assert server.probes == 2


def test_engine_routes_detect_a_server_started_after_a_catalogue_read(outbound_http, monkeypatch):
    """End to end through the routes the renderer calls."""
    from types import SimpleNamespace

    from api.routers import engines

    monkeypatch.setenv("OMNIVOICE_GPTSOVITS_URL", "http://127.0.0.1:9880")
    monkeypatch.setattr(engines.tts_backend, "active_backend_id", lambda: "omnivoice")
    server = _Server()
    monkeypatch.setattr(outbound_http, "open_trusted_endpoint", server)
    request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))

    def listed() -> bool:
        rows = engines.list_tts_backends(request)["backends"]
        return next(row for row in rows if row["id"] == "gpt-sovits")["available"]

    assert listed() is False
    server.running = True
    assert listed() is False  # the catalogue reuses its verdict for a while
    selected = engines.select_engine(engines.SelectEngineRequest(family="tts", backend_id="gpt-sovits"))
    assert selected["family"] == "tts"
    assert listed() is True
    assert engines.engine_health("gpt-sovits")["ok"] is True
