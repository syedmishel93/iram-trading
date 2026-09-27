"""
Every package module the service loads must be named in the binary's HIDDEN list.

`mishel_service` puts its own directory on `sys.path` at RUNTIME and then
imports `db` and `svc.*`. PyInstaller's analyser does not execute that line, so
it cannot follow those imports: a module missing from `HIDDEN` is a module the
packaged product does not contain, and the first anyone hears of it is
`ModuleNotFoundError` from a downloaded .exe. A checkout never shows it.

The list is read with `ast`, not imported, because `build_binary.py` is a build
script and importing it is not something a test should do.
"""

import ast
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server"


def hidden() -> set[str]:
    tree = ast.parse((SERVER / "build_binary.py").read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "HIDDEN" for t in node.targets
        ):
            return {ast.literal_eval(e) for e in node.value.elts}  # type: ignore[attr-defined]
    raise AssertionError("HIDDEN not found in build_binary.py")


def modules(package: str) -> set[str]:
    root = SERVER / package
    out = {package}
    for f in root.glob("*.py"):
        if f.stem != "__init__":
            out.add(f"{package}.{f.stem}")
    return out


def test_hidden_list_is_found_and_nonempty() -> None:
    assert "mishel_service" in hidden()


def test_every_db_module_is_bundled() -> None:
    missing = sorted(modules("db") - hidden())
    assert not missing, f"add to HIDDEN in server/build_binary.py: {missing}"


def test_every_svc_module_is_bundled() -> None:
    missing = sorted(modules("svc") - hidden())
    assert not missing, f"add to HIDDEN in server/build_binary.py: {missing}"
