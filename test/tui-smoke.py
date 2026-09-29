#!/usr/bin/env python3
"""Real pi/TUI test. Never inherit HOME, credentials, PI_* config, or auth commands."""
import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")
CLI = ROOT / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
REQUESTS = []


class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        REQUESTS.append(data)
        messages = json.dumps(data.get("messages", []))
        summary = "<previous-summary>" in messages
        text = "## Goal\nContinue the context inspector work.\n" if summary else f"LOCAL FIXTURE RESPONSE {len(REQUESTS)}"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        # Leave a real request in flight while /context is opened and follows it.
        if len(REQUESTS) == 2:
            time.sleep(3)
        for event in [
            {"id": "fixture-response", "object": "chat.completion.chunk", "model": "fixture", "choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}]},
            {"id": "fixture-response", "object": "chat.completion.chunk", "model": "fixture", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110, "prompt_tokens_details": {"cached_tokens": 40}}},
        ]:
            self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    temp = Path(tempfile.mkdtemp(prefix="pi-context-tui-"))
    home, agent, project = temp / "home", temp / "agent", temp / "project"
    for directory in [home, agent, project]:
        directory.mkdir()
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(home), "SHELL": "/bin/bash", "TERM": "xterm-256color", "LANG": "en_US.UTF-8",
        "PI_CODING_AGENT_DIR": str(agent), "PI_CODING_AGENT_SESSION_DIR": str(temp / "sessions"),
        "PI_OFFLINE": "1", "PI_TELEMETRY": "0", "PI_OTLP_ENABLE": "0", "PI_IMAGE_PROTOCOL": "none",
    }
    (agent / "auth.json").write_text("{}\n")
    editor = temp / "edit-summary.sh"
    editor.write_text('#!/bin/sh\npython3 - "$1" <<\'PY\'\nimport sys\nfrom pathlib import Path\np = Path(sys.argv[1])\np.write_text(p.read_text().replace("WRONG", "correct"))\nPY\n')
    editor.chmod(0o700)
    env["EDITOR"] = str(editor)
    (agent / "settings.json").write_text(json.dumps({
        "theme": "dark", "defaultProvider": "context-test", "defaultModel": "fixture",
        "defaultThinkingLevel": "off", "enableInstallTelemetry": False,
        "compaction": {"enabled": False, "keepRecentTokens": 1, "reserveTokens": 1024},
    }))
    (agent / "models.json").write_text(json.dumps({"providers": {"context-test": {
        "baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "api": "openai-completions", "apiKey": "local-test-only",
        "models": [{"id": "fixture", "reasoning": False, "contextWindow": 128000, "maxTokens": 4096}],
    }}}))
    skill = temp / "fixture-skill" / "SKILL.md"
    skill.parent.mkdir()
    skill.write_text("---\nname: fixture-skill\ndescription: fixture skill routing instructions for safe local testing\n---\nFull skill body is not advertised in the catalog.\n")
    session = temp / "fixture.jsonl"
    fixture = subprocess.check_output([
        NODE, "--import", "tsx", "--input-type=module", "-e",
        'import { fixtureEntries } from "./test/fixtures.ts"; console.log(JSON.stringify(fixtureEntries(process.argv[1], true)));', str(project),
    ], cwd=ROOT, env=env, timeout=15)
    entries = json.loads(fixture)
    session.write_text("".join(json.dumps(e) + "\n" for e in entries))
    original = next(e["summary"] for e in entries if e["type"] == "compaction")
    command = [NODE, str(CLI), "--offline", "--no-extensions", "--no-skills", "--skill", str(skill), "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-approve", "--provider", "context-test", "--model", "fixture", "--thinking", "off", "--session", str(session), "-e", str(ROOT / "src/index.ts")]
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(project)
        os.execve(NODE, command, env)
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt("TUI test interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 130, 0, 0))
    output = bytearray()
    ansi = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]")

    def pump(timeout=0.15):
        if select.select([fd], [], [], timeout)[0]:
            try:
                data = os.read(fd, 65536)
            except OSError:
                raise RuntimeError("pi exited unexpectedly")
            output.extend(data)
            # Answer terminal probes; this pseudo-terminal has no emulator attached.
            if b"\x1b[6n" in data:
                os.write(fd, b"\x1b[1;1R")
            if b"\x1b]11;?" in data:
                os.write(fd, b"\x1b]11;rgb:0000/0000/0000\x07")

    def text(start=0):
        return ansi.sub("", output[start:].decode(errors="replace"))

    def wait_for(needle, start=0, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pump()
            if needle in text(start):
                return
        raise AssertionError(f"Timed out waiting for {needle!r}. Tail:\n{text(start)[-6000:]}")

    def settle(seconds=0.35):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            pump(0.05)

    def send(value):
        mark = len(output)
        os.write(fd, value.encode())
        settle()
        return mark

    def command_line(value):
        return send(value + "\r")

    def read_entries():
        return [json.loads(line) for line in session.read_text().splitlines() if line.strip()]

    try:
        wait_for("Ready for inspection", timeout=30)
        mark = command_line("/context")
        wait_for("Context inspector", mark)
        wait_for("System instructions", mark)
        send("/fixture-read-1"); send("\r")
        wait_for("TOOL CALL · read", mark)
        wait_for("Parameters:", mark)
        wait_for('"path": "README.md"', mark)
        send("1")  # reset the filter
        send("/compaction")
        send("\r")
        wait_for("Compaction summary", mark)
        send("\t")
        send("r")
        # Force the narrow single-pane layout, then restore the split view.
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 70, 0, 0))
        os.kill(pid, signal.SIGWINCH)
        settle()
        send("\x1b[6~")
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 130, 0, 0))
        os.kill(pid, signal.SIGWINCH)
        settle()
        send("\x1b")
        settle()

        # Itemize an explicitly loaded synthetic skill; default discovery remains disabled.
        mark = command_line("/context")
        wait_for("Context inspector", mark)
        send("/Instruction attribution"); send("\r"); send("\r")
        send("/Skill catalog"); send("\r"); send("\r")
        mark = send("/Skill · fixture-skill"); send("\r"); send("\r")
        wait_for("fixture skill routing instructions", mark)
        send("s"); send("\x7f"); send("\x7f")
        send("\x1b"); settle()

        # Failed tool results are visible in Preview without extra model calls.
        mark = command_line("/context")
        wait_for("Context inspector", mark)
        send("/Could not find edits[1]"); send("\r")
        wait_for("Result · edit", mark)
        wait_for("Could not find edits[1]", mark)
        wait_for("Originating call parameters (reference only):", mark)
        wait_for('"path": "README.md"', mark)
        send("l")
        send("\x1b"); settle()

        # Capture two actual requests against only the loopback fake provider.
        mark = command_line("First local test prompt")
        wait_for("LOCAL FIXTURE RESPONSE 1", mark)
        settle()
        command_line("Second local test prompt")
        mark = command_line("/context")
        wait_for("Context inspector", mark)
        mark = send("F")
        wait_for("FOLLOW", mark)
        wait_for("LOCAL FIXTURE RESPONSE 2", mark)
        # Copy no data and invoke no model: navigate the live overlay in place.
        mark = send("h")
        send("g"); send("g")
        wait_for("Context usage & legend", mark)
        send("G"); send("l"); send("\x15"); send("\x04")
        send("\x1b")
        settle()
        mark = command_line("/context request")
        wait_for("Full provider payload", mark)
        send("3")
        wait_for("Previous → latest request", mark)
        send("\x1b")
        settle()

        mark = command_line("/context stats")
        wait_for("Tool usage overview", mark)
        send("/Tool stats · read")
        send("\r")  # leave search
        mark = send("\r")  # drill into call/result pairs
        wait_for("fixture-read-1", mark)
        wait_for("Parameters:", mark)
        send("s")
        send("\t")
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 70, 0, 0))
        os.kill(pid, signal.SIGWINCH)
        settle()
        send("\x1b[6~")
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 130, 0, 0))
        os.kill(pid, signal.SIGWINCH)
        settle()
        send("\x7f")  # back to tool groups
        mark = send("5")
        wait_for("Request input growth", mark)
        send("\x1b")
        settle()
        mark = command_line("/context growth")
        wait_for("Request input growth", mark)
        send("\x1b")
        settle()

        exported = temp / "export.json"
        mark = command_line(f"/context export {exported}")
        wait_for("Export sensitive context?", mark)
        send("\r")  # yes is the first select item
        deadline = time.monotonic() + 5
        while not exported.exists() and time.monotonic() < deadline:
            pump()
        assert exported.exists(), "export confirmation did not save"
        export = json.loads(exported.read_text())
        assert export["version"] == 2
        assert len(export["requests"]) == 2
        tool_stats = next(s["raw"] for s in export["tools"]["sections"] if s["id"] == "tool-stats:read")
        assert tool_stats["calls"] == 2
        assert tool_stats["resultSize"]["tokens"] > 2000
        assert tool_stats["signals"]["Large result then narrower read"] == 1
        assert export["growth"]["kind"] == "growth"
        overview = export["preview"]["sections"][0]
        assert overview["raw"]["estimate"]["tokens"] > 0
        assert overview["raw"]["categories"]["Skill descriptions"]["tokens"] > 0
        instruction_profile = next(s["raw"] for s in export["preview"]["sections"] if s["id"] == "instruction-breakdown")
        assert len(instruction_profile["skills"]) == 1
        assert instruction_profile["skills"][0]["name"] == "fixture-skill"
        assert sum(v["tokens"] for v in instruction_profile["categories"].values()) == instruction_profile["tokens"]
        assert overview["highlights"] and "█" in overview["text"]
        assert "\x1b" not in overview["text"], "Rendering must not embed ANSI in exports"
        tool_group = next(s for s in export["tools"]["sections"] if s["id"] == "tool-stats:read")
        assert tool_group["indicator"] == {"text": "?", "tone": "warning"}
        failed_result = next(s for s in export["preview"]["sections"] if s["id"] == "tool-result-error")
        assert failed_result["indicator"] == {"text": "!", "tone": "error"}
        assert '"path": "README.md"' in failed_result["text"]
        call_section = next(s for s in export["preview"]["sections"] if s["id"] == "tool-assistant-1")
        assert call_section["title"] == "Call · read"
        assert "Parameters:" in call_section["text"]
        assert any(h["tone"] == "error" and "Could not find edits[1]" in failed_result["text"][h["start"]:h["end"]] for h in failed_result["highlights"])
        assert "\x1b" not in failed_result["text"], "Exported error text stays plain"
        assert export["requests"][-1]["usage"]["cacheRead"] == 40
        assert any(s["id"] == "system" for s in export["preview"]["sections"])
        assert len(REQUESTS) == 2, "Inspection/export must not invoke the model"
        settle()

        # Cancelled editing must leave the summary unchanged.
        mark = command_line("/context edit")
        wait_for("Edit compaction", mark)
        send("\x1b")
        assert next(e["summary"] for e in read_entries() if e.get("id") == "compact") == original
        settle()

        # Exercise the real multiline editor's external-editor support.
        mark = command_line("/context edit")
        wait_for("Edit compaction", mark)
        send("\x07")  # Ctrl+G runs our deterministic local script, not a human editor.
        settle(1)
        mark = send("\r")
        wait_for("Review compaction summary edit", mark)
        mark = send("\r")
        wait_for("Saved summary", mark, timeout=30)
        corrected = next(e["summary"] for e in read_entries() if e.get("id") == "compact")
        # Pi's multiline editor trims trailing whitespace on submission.
        assert corrected == original.replace("WRONG", "correct").rstrip()
        assert len(REQUESTS) == 2, "Editing/reopen must not invoke the model"
        assert list(Path(str(session) + ".context-revisions").glob("*.before.jsonl"))
        settle()
        mark = command_line("Verify edited summary")
        wait_for("LOCAL FIXTURE RESPONSE 3", mark)
        wire = json.dumps(REQUESTS[-1])
        assert "correct database" in wire and "WRONG database" not in wire
        settle()

        mark = command_line("/context undo")
        wait_for("Review compaction summary edit", mark)
        mark = send("\r")
        wait_for("Undid summary edit", mark, timeout=30)
        assert next(e["summary"] for e in read_entries() if e.get("id") == "compact") == original
        settle()
        mark = command_line("Verify undone summary")
        wait_for("LOCAL FIXTURE RESPONSE 4", mark)
        assert "WRONG database" in json.dumps(REQUESTS[-1])
        settle()

        # Correct again, then check that pi's NEXT compaction uses the persisted edit.
        mark = command_line("/context edit")
        wait_for("Edit compaction", mark)
        send("\x07"); settle(1)
        mark = send("\r"); wait_for("Review compaction summary edit", mark)
        mark = send("\r"); wait_for("Saved summary", mark, timeout=30)
        settle()
        command_line("/compact")
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            pump()
            if len([e for e in read_entries() if e.get("type") == "compaction"]) == 2:
                break
        assert len([e for e in read_entries() if e.get("type") == "compaction"]) == 2
        summary_requests = [r for r in REQUESTS if "<previous-summary>" in json.dumps(r)]
        assert summary_requests, "Expected a real pi compaction request"
        assert "correct database" in json.dumps(summary_requests[-1])
        assert "WRONG database" not in json.dumps(summary_requests[-1])
        print("PASS: real TUI live follow during a request, vim navigation, estimates, tool stats/drilldown/resize, growth, capture/diff/export, cancellation, edit/reopen, undo, subsequent model context and compaction.")
        print("Auth isolation: temporary HOME + PI_CODING_AGENT_DIR, empty auth, env allowlist, offline startup, loopback fake provider only.")
        os.write(fd, b"/quit\r")
    except Exception:
        (temp / "terminal.log").write_bytes(output)
        print(f"Failure artifacts: {temp}", flush=True)
        raise
    finally:
        server.shutdown()
        # Wait only on our child PID, not its terminal foreground process group.
        # Pi can be blocked flushing output if the PTY is no longer being drained.
        deadline = time.monotonic() + 3
        reaped = False
        while time.monotonic() < deadline:
            try:
                if os.waitpid(pid, os.WNOHANG)[0]:
                    reaped = True
                    break
            except ChildProcessError:
                reaped = True
                break
            try:
                if select.select([fd], [], [], 0.05)[0]:
                    os.read(fd, 65536)
            except OSError:
                time.sleep(0.05)
        if not reaped:
            try:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass
        os.close(fd)
        if not (temp / "terminal.log").exists():
            shutil.rmtree(temp)


if __name__ == "__main__":
    main()
