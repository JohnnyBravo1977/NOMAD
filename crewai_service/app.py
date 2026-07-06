import os
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Optional, Type
from uuid import uuid4

import docker
from crewai.tools import BaseTool
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import AliasChoices, BaseModel, Field

app = FastAPI(title="nomad-crewai", version="1.0.0")

ALLOWED_FILE_ROOTS = [
    "/data/projects/NOMAD",
    "/data/project-nomad",
]
MAX_FILE_BYTES = 64 * 1024
JOB_DIR = Path("/tmp/crewai-jobs")
JOB_DIR.mkdir(parents=True, exist_ok=True)


class RunRequest(BaseModel):
    tool: str
    input: dict


class RunResponse(BaseModel):
    tool: str
    result: str


class JobReceipt(BaseModel):
    job_id: str
    status: str


class JobStatus(BaseModel):
    job_id: str
    status: str
    tool: Optional[str] = None
    result: Optional[str] = None
    error: Optional[str] = None


class DiagnoseContainerInput(BaseModel):
    container_name: str = Field(
        ...,
        description="Docker container name to diagnose",
        validation_alias=AliasChoices("container_name", "container"),
    )


class PatchFileAndVerifyInput(BaseModel):
    file_path: str = Field(
        ...,
        description="Absolute file path to patch",
        validation_alias=AliasChoices("file_path", "file"),
    )
    search: str = Field(..., description="Exact text to replace")
    replace: str = Field(..., description="Replacement text")
    service_name: Optional[str] = Field(
        None,
        description="Managed service/container to restart and verify",
        validation_alias=AliasChoices("service_name", "service"),
    )


class RestartAndVerifyServiceInput(BaseModel):
    service_name: str = Field(
        ...,
        description="Managed service/container name to restart and verify",
        validation_alias=AliasChoices("service_name", "service"),
    )


class InspectLogsConfigAndFilesInput(BaseModel):
    container_name: str = Field(
        ...,
        description="Container name to inspect for logs, config, and file structure",
        validation_alias=AliasChoices("container_name", "container"),
    )


class DiagnoseHomeAssistantInput(BaseModel):
    pass


class RepairServiceFromLogsInput(BaseModel):
    service_name: str = Field(
        ...,
        description="Managed service/container name to inspect, restart, and verify",
        validation_alias=AliasChoices("service_name", "service"),
    )


def get_docker() -> docker.DockerClient:
    return docker.from_env()


def normalize_service_name(raw_name: str) -> str:
    value = raw_name.strip()
    if value.startswith("nomad_"):
        return value
    return f"nomad_{value}"


def strip_ansi(text: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*m", "", text)


def resolve_allowed_path(requested_path: str) -> Path:
    resolved = Path(requested_path).expanduser().resolve()
    allowed = any(
        str(resolved) == root or str(resolved).startswith(f"{root}/") for root in ALLOWED_FILE_ROOTS
    )
    if not allowed:
        raise ValueError(f"Path {requested_path} is outside the allowed worker-flow roots.")
    return resolved


def find_container(raw_name: str):
    client = get_docker()
    containers = client.containers.list(all=True)
    normalized = raw_name.strip().lower()
    prefixed = normalize_service_name(normalized)

    def names_for(container) -> list[str]:
        return [name.lstrip("/").lower() for name in (container.attrs.get("Name"), *container.attrs.get("Config", {}).get("Labels", {}).values()) if isinstance(name, str)]

    exact = None
    contains = None
    for container in containers:
        names = set(names_for(container) + [container.name.lower()])
        if normalized in names or prefixed in names:
            exact = container
            break
        if any(normalized in name or prefixed in name for name in names):
            contains = contains or container

    return exact or contains


class InspectContainerToolInput(BaseModel):
    container_name: str = Field(..., description="Docker container name to inspect")


class InspectContainerTool(BaseTool):
    name: str = "inspect_docker_container"
    description: str = "Inspect one Docker container and return its current status, image, ports, and mounts."
    args_schema: Type[BaseModel] = InspectContainerToolInput

    def _run(self, container_name: str) -> str:
        container = find_container(container_name)
        if not container:
            return f"I couldn't find a container named {container_name}."

        info = container.attrs
        image = info.get("Config", {}).get("Image", "unknown")
        state = info.get("State", {}).get("Status", "unknown")
        ports = []
        for container_port, bindings in (info.get("NetworkSettings", {}).get("Ports") or {}).items():
            if bindings:
                for binding in bindings:
                    ports.append(f"{binding.get('HostPort')}->{container_port}")
            else:
                ports.append(container_port)
        mounts = [f"{m.get('Source')} -> {m.get('Destination')}" for m in info.get("Mounts", [])[:6]]
        lines = [
            f"Container {container.name}:",
            f"Status: {state}",
            f"Image: {image}",
        ]
        if ports:
            lines.append(f"Ports: {', '.join(ports[:8])}")
        if mounts:
            lines.append(f"Mounts: {'; '.join(mounts)}")
        return "\n".join(lines)


class ContainerLogsToolInput(BaseModel):
    container_name: str = Field(..., description="Docker container name whose recent logs should be read")


class ContainerLogsTool(BaseTool):
    name: str = "read_container_logs"
    description: str = "Read the most recent logs from a Docker container."
    args_schema: Type[BaseModel] = ContainerLogsToolInput

    def _run(self, container_name: str) -> str:
        container = find_container(container_name)
        if not container:
            return f"I couldn't find a container named {container_name}."
        raw = container.logs(stdout=True, stderr=True, tail=40)
        text = strip_ansi(raw.decode("utf-8", errors="replace")).strip()
        lines = [line for line in text.splitlines() if line.strip()][-20:]
        if not lines:
            return f"I checked {container.name}, but there were no recent log lines to show."
        return f"Recent logs for {container.name}:\n" + "\n".join(lines)


class HomeAssistantStructureInput(BaseModel):
    container_name: str = Field(..., description="Home Assistant container name to inspect")


class HomeAssistantStructureTool(BaseTool):
    name: str = "inspect_home_assistant_config"
    description: str = "List the top-level Home Assistant /config entries for a running Home Assistant container."
    args_schema: Type[BaseModel] = HomeAssistantStructureInput

    def _run(self, container_name: str) -> str:
        container = find_container(container_name)
        if not container:
            return f"I couldn't find a container named {container_name}."
        exec_result = container.exec_run("sh -lc 'ls -1A /config | head -n 40'")
        output = exec_result.output.decode("utf-8", errors="replace").strip()
        if exec_result.exit_code != 0:
            return f"I couldn't inspect /config in {container.name}."
        entries = [line for line in output.splitlines() if line.strip()]
        if not entries:
            return f"I checked /config in {container.name}, but it looked empty."
        return f"Top-level /config entries for {container.name}:\n" + "\n".join(entries)


class ReadFileToolInput(BaseModel):
    file_path: str = Field(..., description="Absolute file path to read")


class ReadFileTool(BaseTool):
    name: str = "read_file"
    description: str = "Read a text file from the allowed worker-flow roots."
    args_schema: Type[BaseModel] = ReadFileToolInput

    def _run(self, file_path: str) -> str:
        resolved = resolve_allowed_path(file_path)
        if not resolved.is_file():
            return f"{resolved} is not a file."
        content = resolved.read_text(encoding="utf-8")
        trimmed = content if len(content.encode("utf-8")) <= MAX_FILE_BYTES else content[:MAX_FILE_BYTES] + "\n...[truncated]"
        return f"Contents of {resolved}:\n{trimmed}"


class ReplaceInFileToolInput(BaseModel):
    file_path: str = Field(..., description="Absolute file path to patch")
    search: str = Field(..., description="Exact text to replace")
    replace: str = Field(..., description="Replacement text")


class ReplaceInFileTool(BaseTool):
    name: str = "edit_file"
    description: str = "Replace exact text inside a file under the allowed worker-flow roots."
    args_schema: Type[BaseModel] = ReplaceInFileToolInput

    def _run(self, file_path: str, search: str, replace: str) -> str:
        resolved = resolve_allowed_path(file_path)
        if not resolved.is_file():
            return f"{resolved} is not a file."
        original = resolved.read_text(encoding="utf-8")
        count = original.count(search)
        if count <= 0:
            return f'I couldn\'t find "{search}" in {resolved}.'
        updated = original.replace(search, replace)
        if len(updated.encode("utf-8")) > MAX_FILE_BYTES:
            return f"I couldn't write the updated content because it would exceed {MAX_FILE_BYTES} bytes."
        resolved.write_text(updated, encoding="utf-8")
        return f"Replaced {count} occurrence{'s' if count != 1 else ''} in {resolved}."


class RestartServiceToolInput(BaseModel):
    service_name: str = Field(..., description="Managed container/service name to restart")


class RestartServiceTool(BaseTool):
    name: str = "restart_service"
    description: str = "Restart a managed Docker container such as nomad_admin or nomad_ollama."
    args_schema: Type[BaseModel] = RestartServiceToolInput

    def _run(self, service_name: str) -> str:
        container = find_container(service_name)
        if not container:
            return f"I couldn't find a managed service named {service_name}."
        container.restart(timeout=10)
        container.reload()
        return f"Restarted {container.name}. Current status: {container.status}"


class ServiceStatusToolInput(BaseModel):
    service_name: str = Field(..., description="Managed container/service name to verify")


class ServiceStatusTool(BaseTool):
    name: str = "verify_service_status"
    description: str = "Check the current status of a managed Docker container."
    args_schema: Type[BaseModel] = ServiceStatusToolInput

    def _run(self, service_name: str) -> str:
        container = find_container(service_name)
        if not container:
            return f"I couldn't find a managed service named {service_name}."
        container.reload()
        return f"Service {container.name} status: {container.status}"


def format_section(title: str, body: str) -> str:
    cleaned = (body or "").strip() or "No result."
    return f"{title}:\n{cleaned}"


def find_first_signal(*texts: str) -> Optional[str]:
    patterns = (
        r"^.*\bERROR\b.*$",
        r"^.*\bWARN(?:ING)?\b.*$",
        r"^.*Missing required permissions.*$",
        r"^.*couldn't find.*$",
        r"^.*status:\s+[a-z]+.*$",
    )
    lines = []
    for text in texts:
        lines.extend(line.strip() for line in text.splitlines())

    for pattern in patterns:
        for stripped in lines:
            if not stripped:
                continue
            if re.search(pattern, stripped, re.IGNORECASE):
                return stripped
    return None


def render_diagnose_container_result(container_name: str, steps: list[tuple[str, str]]) -> str:
    evidence = "\n\n".join(format_section(title, result) for title, result in steps)
    signal = find_first_signal(*(result for _, result in steps))
    intro = [
        f"I checked the {container_name} container.",
        "I looked at the container details, the recent logs, and the available config structure.",
    ]
    if signal:
        intro.append(f"The main thing that stands out is: {signal}")
    return "\n".join(
        [
            " ".join(intro),
            "",
            "What I found:",
            evidence,
        ]
    )


def render_patch_file_and_verify_result(file_path: str, steps: list[tuple[str, str]]) -> str:
    patch_result = next((result for title, result in steps if title == "Step 2 — patch result"), "")
    if "couldn't find" in patch_result:
        intro = (
            f"I checked {file_path}, but there was nothing to replace with the text you gave me."
        )
    else:
        intro = f"I updated {file_path} and verified the result."

    evidence = "\n\n".join(format_section(title, result) for title, result in steps)
    return "\n".join(
        [
            intro,
            "",
            "What I found:",
            evidence,
        ]
    )


def render_restart_and_verify_service_result(service_name: str, steps: list[tuple[str, str]]) -> str:
    evidence = "\n\n".join(format_section(title, result) for title, result in steps)
    restart_result = next((result for title, result in steps if title == "Step 1 — restart result"), "")
    verification = next((result for title, result in steps if title == "Step 2 — verification status"), "")
    if "couldn't find a managed service" in restart_result.lower():
        intro = f"I couldn't restart {service_name} because I couldn't find that managed service."
    elif "running" in verification.lower():
        intro = f"I restarted {service_name} and it came back running."
    else:
        intro = f"I restarted {service_name} and checked its status afterward."
    return "\n".join(
        [
            intro,
            "",
            "What I found:",
            evidence,
        ]
    )


def render_inspect_logs_config_and_files_result(container_name: str, steps: list[tuple[str, str]]) -> str:
    evidence = "\n\n".join(format_section(title, result) for title, result in steps)
    signal = find_first_signal(*(result for _, result in steps))
    intro = [f"I inspected {container_name}.", "I checked the recent logs, the config, and the file structure."]
    if signal:
        intro.append(f"The main thing that stands out is: {signal}")
    return "\n".join(
        [
            " ".join(intro),
            "",
            "What I found:",
            evidence,
        ]
    )


def render_diagnose_home_assistant_result(steps: list[tuple[str, str]]) -> str:
    evidence = "\n\n".join(format_section(title, result) for title, result in steps)
    signal = find_first_signal(*(result for _, result in steps))
    intro = [
        "I checked the Home Assistant setup.",
        "I looked at the container, the recent logs, and the current /config structure.",
    ]
    if signal:
        intro.append(f"The main thing that stands out is: {signal}")
    return "\n".join(
        [
            " ".join(intro),
            "",
            "What I found:",
            evidence,
        ]
    )


def render_repair_service_from_logs_result(service_name: str, steps: list[tuple[str, str]]) -> str:
    evidence = "\n\n".join(format_section(title, result) for title, result in steps)
    signal = find_first_signal(*(result for _, result in steps))
    restart_result = next((result for title, result in steps if title == "Step 3 — restart result"), "")
    verification = next((result for title, result in steps if title == "Step 4 — verification status"), "")
    intro = [
        f"I tried the safest bounded repair step I have for {service_name}.",
    ]
    if "couldn't find a managed service" in restart_result.lower():
        intro.append("I could inspect the request, but I could not find that managed service to restart it.")
    elif "running" in verification.lower():
        intro.append("I checked the current service state and recent logs, then restarted it and verified that it came back running.")
    else:
        intro.append("I checked the current service state and recent logs, then restarted it and verified the result.")
    if signal:
        intro.append(f"The main thing that stood out before the restart was: {signal}")
    return "\n".join(
        [
            " ".join(intro),
            "",
            "What I found:",
            evidence,
        ]
    )


def run_diagnose_container(payload: DiagnoseContainerInput) -> str:
    steps = [
        ("Step 1 — container inspection", InspectContainerTool()._run(payload.container_name)),
        ("Step 2 — recent logs", ContainerLogsTool()._run(payload.container_name)),
    ]
    if "homeassistant" in payload.container_name.lower():
        steps.append(
            (
                "Step 3 — config structure",
                HomeAssistantStructureTool()._run(payload.container_name),
            )
        )

    return render_diagnose_container_result(payload.container_name, steps)


def run_patch_file_and_verify(payload: PatchFileAndVerifyInput) -> str:
    steps = [
        ("Step 1 — file before patch", ReadFileTool()._run(payload.file_path)),
        (
            "Step 2 — patch result",
            ReplaceInFileTool()._run(payload.file_path, payload.search, payload.replace),
        ),
        ("Step 3 — file after patch", ReadFileTool()._run(payload.file_path)),
    ]

    if payload.service_name:
        steps.append(
            (
                "Step 4 — restart result",
                RestartServiceTool()._run(payload.service_name),
            )
        )
        steps.append(
            (
                "Step 5 — verification status",
                ServiceStatusTool()._run(payload.service_name),
            )
        )

    return render_patch_file_and_verify_result(payload.file_path, steps)


def run_restart_and_verify_service(payload: RestartAndVerifyServiceInput) -> str:
    steps = [
        ("Step 1 — restart result", RestartServiceTool()._run(payload.service_name)),
        ("Step 2 — verification status", ServiceStatusTool()._run(payload.service_name)),
    ]

    return render_restart_and_verify_service_result(payload.service_name, steps)


def run_inspect_logs_config_and_files(payload: InspectLogsConfigAndFilesInput) -> str:
    steps = [
        ("Step 1 — container inspection", InspectContainerTool()._run(payload.container_name)),
        ("Step 2 — recent logs", ContainerLogsTool()._run(payload.container_name)),
    ]
    if "homeassistant" in payload.container_name.lower():
        steps.append(
            (
                "Step 3 — config structure",
                HomeAssistantStructureTool()._run(payload.container_name),
            )
        )

    return render_inspect_logs_config_and_files_result(payload.container_name, steps)


def run_diagnose_home_assistant(_payload: DiagnoseHomeAssistantInput) -> str:
    container_name = "homeassistant"
    steps = [
        ("Step 1 — container inspection", InspectContainerTool()._run(container_name)),
        ("Step 2 — recent logs", ContainerLogsTool()._run(container_name)),
        ("Step 3 — config structure", HomeAssistantStructureTool()._run(container_name)),
    ]

    return render_diagnose_home_assistant_result(steps)


def run_repair_service_from_logs(payload: RepairServiceFromLogsInput) -> str:
    steps = [
        ("Step 1 — container inspection", InspectContainerTool()._run(payload.service_name)),
        ("Step 2 — recent logs", ContainerLogsTool()._run(payload.service_name)),
        ("Step 3 — restart result", RestartServiceTool()._run(payload.service_name)),
        ("Step 4 — verification status", ServiceStatusTool()._run(payload.service_name)),
    ]

    return render_repair_service_from_logs_result(payload.service_name, steps)


@app.get("/health")
def health():
    return {"status": "ok"}


def write_job(job_id: str, payload: dict):
    JOB_DIR.mkdir(parents=True, exist_ok=True)
    (JOB_DIR / f"{job_id}.json").write_text(json.dumps(payload), encoding="utf-8")


def read_job(job_id: str) -> Optional[dict]:
    target = JOB_DIR / f"{job_id}.json"
    if not target.exists():
        return None
    return json.loads(target.read_text(encoding="utf-8"))


def execute_job(job_id: str, request_payload: dict):
    try:
        request = RunRequest.model_validate(request_payload)
        if request.tool == "diagnose_container":
            payload = DiagnoseContainerInput.model_validate(request.input)
            result = run_diagnose_container(payload)
        elif request.tool == "patch_file_and_verify":
            payload = PatchFileAndVerifyInput.model_validate(request.input)
            result = run_patch_file_and_verify(payload)
        elif request.tool == "restart_and_verify_service":
            payload = RestartAndVerifyServiceInput.model_validate(request.input)
            result = run_restart_and_verify_service(payload)
        elif request.tool == "inspect_logs_config_and_files":
            payload = InspectLogsConfigAndFilesInput.model_validate(request.input)
            result = run_inspect_logs_config_and_files(payload)
        elif request.tool == "diagnose_home_assistant":
            payload = DiagnoseHomeAssistantInput.model_validate(request.input)
            result = run_diagnose_home_assistant(payload)
        elif request.tool == "repair_service_from_logs":
            payload = RepairServiceFromLogsInput.model_validate(request.input)
            result = run_repair_service_from_logs(payload)
        else:
            raise ValueError(f"Unsupported worker-flow tool: {request.tool}")
        write_job(
            job_id,
            {
                "job_id": job_id,
                "tool": request.tool,
                "status": "completed",
                "result": result,
                "error": None,
            },
        )
        print(f"[crewai] completed {request.tool} with {len(result)} characters")
    except Exception as error:
        write_job(
            job_id,
            {
                "job_id": job_id,
                "tool": request_payload.get("tool"),
                "status": "failed",
                "result": None,
                "error": str(error),
            },
        )


@app.post("/run")
def run_worker_flow(request: RunRequest):
    if request.tool not in {
        "diagnose_container",
        "patch_file_and_verify",
        "restart_and_verify_service",
        "inspect_logs_config_and_files",
        "diagnose_home_assistant",
        "repair_service_from_logs",
    }:
        raise HTTPException(status_code=400, detail=f"Unsupported worker-flow tool: {request.tool}")

    job_id = uuid4().hex
    write_job(
        job_id,
        {
            "job_id": job_id,
            "tool": request.tool,
            "status": "running",
            "result": None,
            "error": None,
        },
    )

    subprocess.Popen(
        [
            sys.executable,
            "-c",
            (
                "import json, sys; "
                "from app import execute_job; "
                "execute_job(sys.argv[1], json.loads(sys.argv[2]))"
            ),
            job_id,
            json.dumps(request.model_dump()),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=os.environ.copy(),
    )
    return JSONResponse(content={"job_id": job_id, "status": "running"})


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    job = read_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Unknown job id: {job_id}")
    return JSONResponse(content=job)
