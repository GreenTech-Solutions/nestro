#!/usr/bin/env python3
"""Compares registry copies of the release VSIX with the candidate; stdlib only.

usage: compare-published.py compare CANDIDATE PUBLISHED...
       compare-published.py budget
"""
import hashlib
import json
import os
import stat
import sys
import xml.etree.ElementTree as ET
import zipfile

EXTENSION_PREFIX = "extension/"
CONTRACT_PATH = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "release-contract.json")


def fail(message):
    raise SystemExit(message)


def load_budget():
    try:
        with open(CONTRACT_PATH, encoding="utf-8") as handle:
            budget = json.load(handle)["vsixBudget"]
        return {
            "files": budget["baselinePackagedFileCount"] + budget["packagedFileCountHeadroom"],
            "compressed": budget["baselineCompressedBytes"] * (100 + budget["compressedHeadroomPercent"]) // 100,
            "entry": budget["maxEntryBytes"],
            "uncompressed": budget["maxUncompressedBytes"],
        }
    except (OSError, KeyError, TypeError, ValueError) as error:
        fail(f"release contract budget is unreadable: {error}")


def is_unsafe_path(name):
    return (not name or name.startswith("/") or "\\" in name
            or any(part in ("", "..") for part in name.split("/"))
            or name.endswith("/"))


def check_budget(path, infos, budget):
    packaged_files = [info for info in infos if info.filename.startswith(EXTENSION_PREFIX)]
    if len(packaged_files) > budget["files"]:
        fail(f"published VSIX has too many packaged files: {len(packaged_files)}")
    if os.path.getsize(path) > budget["compressed"]:
        fail(f"published VSIX compressed payload exceeds {budget['compressed']} bytes")
    if sum(info.file_size for info in infos) > budget["uncompressed"]:
        fail(f"published VSIX expanded payload exceeds {budget['uncompressed']} bytes")


def read_entries(path, budget):
    entries = []
    seen = set()
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            check_budget(path, infos, budget)
            for info in infos:
                name = info.filename
                if info.file_size > budget["entry"]:
                    fail(f"published VSIX entry is too large: {name}")
                if is_unsafe_path(name):
                    fail(f"unsafe published archive path: {name}")
                if name in seen:
                    fail(f"duplicate published archive path: {name}")
                seen.add(name)
                if stat.S_IFMT((info.external_attr >> 16) & 0xffff) == stat.S_IFLNK:
                    fail(f"published archive contains a symlink: {name}")
                entries.append((name, archive.read(info)))
    except (OSError, zipfile.BadZipFile, RuntimeError, ValueError) as error:
        fail(f"unsafe published VSIX: {error}")
    return entries


def local_name(node):
    return node.tag.rsplit("}", 1)[-1]


def package_identity(by_name):
    try:
        package = json.loads(by_name["extension/package.json"])
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"published package manifest is invalid: {error}")
    identity = tuple(package.get(key) if isinstance(package, dict) else None for key in ("name", "version", "publisher"))
    if any(not isinstance(value, str) or not value for value in identity):
        fail("published package manifest identity is incomplete")
    return identity


def outer_identity(by_name):
    outer = by_name.get("extension.vsixmanifest")
    if outer is None or b"<!DOCTYPE" in outer.upper() or b"<!ENTITY" in outer.upper():
        fail("published outer manifest is missing or contains forbidden declarations")
    try:
        root = ET.fromstring(outer)
        metadata = next(child for child in root if local_name(child) == "Metadata")
        node = next(child for child in metadata if local_name(child) == "Identity")
    except (ET.ParseError, StopIteration) as error:
        fail(f"published outer manifest identity is invalid: {error}")
    return (node.attrib.get("Id"), node.attrib.get("Version"), node.attrib.get("Publisher"))


def inspect(path, budget):
    entries = read_entries(path, budget)
    by_name = dict(entries)
    identity = package_identity(by_name)
    if outer_identity(by_name) != identity:
        fail("published VSIX package and outer identities differ")
    normalized = "".join(
        f"{hashlib.sha256(content).hexdigest()}  {name}\n"
        for name, content in sorted(entries)
    )
    with open(path, "rb") as handle:
        return handle.read(), identity, normalized


def compare(candidate_path, published_paths):
    budget = load_budget()
    candidate, candidate_identity, candidate_manifest = inspect(candidate_path, budget)
    for registry_path in published_paths:
        published, identity, manifest = inspect(registry_path, budget)
        if published == candidate:
            print(f"{registry_path}: exact candidate bytes")
        elif identity == candidate_identity and manifest == candidate_manifest:
            print(f"{registry_path}: accepted explicit registry re-pack")
        else:
            fail(f"{registry_path}: registry copy does not match candidate identity and normalized manifest")


def main(argv):
    if argv[1:] == ["budget"]:
        print(load_budget()["compressed"])
    elif len(argv) >= 4 and argv[1] == "compare":
        compare(argv[2], argv[3:])
    else:
        fail(__doc__)


if __name__ == "__main__":
    main(sys.argv)
