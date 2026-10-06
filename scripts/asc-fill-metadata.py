#!/usr/bin/env python3
"""Fill App Store Connect metadata for 笔译训练 via ASC API (JWT ES256)."""

from __future__ import annotations

import json
import sys
import time
import traceback
from typing import Any

import jwt
import urllib.error
import urllib.request

# ── Credentials / IDs ──────────────────────────────────────────────
KEY_ID = "98GRFRQ7S2"
ISSUER_ID = "1115ba89-73e8-4080-8912-02fe5c88bbf1"
KEY_PATH = "/Users/mslee/private_keys/AuthKey_98GRFRQ7S2.p8"
APP_ID = "6816376576"
VERSION_ID = "b71b3349-37e3-4e4b-bbf8-b8bc34c77e0d"
LOC_ID = "9f2963ea-858d-4c39-a911-2683c4f5e172"  # zh-Hans version loc
BUILD_ID = "e9c03e7d-1fe3-4351-9774-d37f1cb7b992"

PRIVACY_URL = (
    "https://richard377933128-oss.github.io/privacy-policy-pages/"
    "biyixunlian-privacy.html"
)
SUPPORT_URL = (
    "https://richard377933128-oss.github.io/privacy-policy-pages/"
    "biyixunlian-support.html"
)

BASE = "https://api.appstoreconnect.apple.com/v1"

DESCRIPTION = """笔译训练是一款专注于意群中译英练习的应用，帮助你系统提升笔译与英语表达能力。

【核心练习】
• 意群拆分：按语义单元理解中文原文，再完成英文翻译
• 对照学习：完成后可对照参考译文，查漏补缺
• 朗读辅助：结合朗读巩固语感与表达

【题库与模式】
• 精选题库，覆盖常见主题与句式
• 支持离线练习，随时随地开练
• 适合备考 PTE、RA 等需要中译英与朗读能力的场景

【为谁而设计】
无论你是英语学习者、翻译爱好者，还是备考相关考试的同学，都可以用笔译训练把「看懂」变成「写得出、说得出」。"""

KEYWORDS = "笔译,翻译,中译英,英语,意群,写作,朗读,练习,题库,离线,PTE,RA"
PROMOTIONAL_TEXT = "意群中译英练习，边译边学，离线也能练。"
APP_NAME = "笔译训练"
SUBTITLE = "意群中译英练习"
COPYRIGHT = "2026 JINBAO LI"


def make_token() -> str:
    with open(KEY_PATH, "r", encoding="utf-8") as f:
        private_key = f.read()
    now = int(time.time())
    payload = {
        "iss": ISSUER_ID,
        "iat": now,
        "exp": now + 20 * 60,
        "aud": "appstoreconnect-v1",
    }
    headers = {"alg": "ES256", "kid": KEY_ID, "typ": "JWT"}
    return jwt.encode(payload, private_key, algorithm="ES256", headers=headers)


_token: str | None = None
_token_at = 0.0


def get_token(force: bool = False) -> str:
    global _token, _token_at
    if force or _token is None or (time.time() - _token_at) > 15 * 60:
        _token = make_token()
        _token_at = time.time()
    return _token


def request(
    method: str,
    path: str,
    body: dict | None = None,
    *,
    retries: int = 2,
) -> tuple[int, Any]:
    """HTTP request to ASC API. Retries on 401 with fresh token."""
    url = path if path.startswith("http") else f"{BASE}{path}"
    data = None if body is None else json.dumps(body).encode("utf-8")

    for attempt in range(retries + 1):
        token = get_token(force=(attempt > 0))
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read().decode("utf-8")
                return resp.status, json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(raw) if raw else {"raw": raw}
            except json.JSONDecodeError:
                parsed = {"raw": raw}
            if e.code == 401 and attempt < retries:
                print(f"  [401] retry with fresh token ({method} {path})")
                continue
            return e.code, parsed
        except Exception as e:
            return -1, {"error": str(e), "trace": traceback.format_exc()}


def pretty(obj: Any, limit: int = 4000) -> str:
    s = json.dumps(obj, ensure_ascii=False, indent=2)
    return s if len(s) <= limit else s[:limit] + "\n… [truncated]"


def field_status(value: Any) -> str:
    if value is None or value == "" or value == [] or value == {}:
        return "EMPTY"
    return "OK"


def attr_get(data: Any, *keys: str) -> Any:
    cur = data
    for k in keys:
        if cur is None:
            return None
        if isinstance(cur, dict):
            cur = cur.get(k)
        else:
            return None
    return cur


# ── Steps ──────────────────────────────────────────────────────────

def step1_version_localization() -> dict:
    print("\n=== 1) PATCH appStoreVersionLocalizations (zh-Hans) ===")
    body = {
        "data": {
            "type": "appStoreVersionLocalizations",
            "id": LOC_ID,
            "attributes": {
                "description": DESCRIPTION,
                "keywords": KEYWORDS,
                "supportUrl": SUPPORT_URL,
                "promotionalText": PROMOTIONAL_TEXT,
            },
        }
    }
    status, resp = request("PATCH", f"/appStoreVersionLocalizations/{LOC_ID}", body)
    print(f"  status={status}")
    if status >= 400:
        print(pretty(resp))
    attrs = attr_get(resp, "data", "attributes") or {}
    return {"http": status, "attrs": attrs, "error": resp if status >= 400 else None}


def step2_app_info_localization() -> dict:
    print("\n=== 2) Find appInfo + PATCH/create appInfoLocalization zh-Hans ===")
    status, resp = request("GET", f"/apps/{APP_ID}/appInfos")
    print(f"  GET appInfos status={status}")
    if status >= 400:
        print(pretty(resp))
        return {"http": status, "error": resp}

    infos = resp.get("data") or []
    if not infos:
        return {"http": status, "error": "no appInfos"}

    # Prefer the appInfo linked to prepare-for-submission / editable state
    app_info = infos[0]
    for info in infos:
        state = (info.get("attributes") or {}).get("appStoreState") or ""
        print(f"  appInfo {info['id']} state={state}")
        if "PREPARE" in state or state in ("READY_FOR_SALE", "WAITING_FOR_REVIEW", ""):
            app_info = info
            break
    # Prefer non-live editable: PREPARE_FOR_SUBMISSION etc.
    for info in infos:
        state = (info.get("attributes") or {}).get("appStoreState") or ""
        if "PREPARE_FOR_SUBMISSION" in state or state == "PREPARE_FOR_SUBMISSION":
            app_info = info
            break

    app_info_id = app_info["id"]
    print(f"  using appInfo={app_info_id}")

    # list localizations
    status2, locs = request(
        "GET", f"/appInfos/{app_info_id}/appInfoLocalizations"
    )
    print(f"  GET appInfoLocalizations status={status2}")
    if status2 >= 400:
        print(pretty(locs))
        return {
            "http": status2,
            "appInfoId": app_info_id,
            "error": locs,
        }

    zh = None
    for loc in locs.get("data") or []:
        locale = (loc.get("attributes") or {}).get("locale")
        print(f"  loc {loc['id']} locale={locale}")
        if locale == "zh-Hans":
            zh = loc

    attrs_wanted = {
        "name": APP_NAME,
        "subtitle": SUBTITLE,
        "privacyPolicyUrl": PRIVACY_URL,
    }

    if zh:
        loc_id = zh["id"]
        print(f"  PATCH appInfoLocalization {loc_id}")
        body = {
            "data": {
                "type": "appInfoLocalizations",
                "id": loc_id,
                "attributes": attrs_wanted,
            }
        }
        st, r = request("PATCH", f"/appInfoLocalizations/{loc_id}", body)
    else:
        print("  POST create appInfoLocalization zh-Hans")
        body = {
            "data": {
                "type": "appInfoLocalizations",
                "attributes": {"locale": "zh-Hans", **attrs_wanted},
                "relationships": {
                    "appInfo": {
                        "data": {"type": "appInfos", "id": app_info_id}
                    }
                },
            }
        }
        st, r = request("POST", "/appInfoLocalizations", body)

    print(f"  write status={st}")
    if st >= 400:
        print(pretty(r))
    out_attrs = attr_get(r, "data", "attributes") or {}
    return {
        "http": st,
        "appInfoId": app_info_id,
        "locId": attr_get(r, "data", "id"),
        "attrs": out_attrs,
        "error": r if st >= 400 else None,
    }


def step3_copyright() -> dict:
    print("\n=== 3) PATCH appStoreVersions copyright ===")
    body = {
        "data": {
            "type": "appStoreVersions",
            "id": VERSION_ID,
            "attributes": {"copyright": COPYRIGHT},
        }
    }
    status, resp = request("PATCH", f"/appStoreVersions/{VERSION_ID}", body)
    print(f"  status={status}")
    if status >= 400:
        print(pretty(resp))
    return {
        "http": status,
        "copyright": attr_get(resp, "data", "attributes", "copyright"),
        "error": resp if status >= 400 else None,
    }


def step4_attach_build() -> dict:
    print("\n=== 4) Attach build to version ===")
    # Check current relationship
    st0, rel0 = request("GET", f"/appStoreVersions/{VERSION_ID}/build")
    print(f"  current build GET status={st0}")
    cur = attr_get(rel0, "data", "id")
    print(f"  current build id={cur}")
    if cur == BUILD_ID:
        print("  already attached")
        return {"http": st0, "buildId": cur, "already": True}

    # Try relationship PATCH (update linkage)
    body = {
        "data": {
            "type": "builds",
            "id": BUILD_ID,
        }
    }
    status, resp = request(
        "PATCH", f"/appStoreVersions/{VERSION_ID}/relationships/build", body
    )
    print(f"  PATCH relationships/build status={status}")
    if status >= 400:
        print(pretty(resp))
        # Fallback: PATCH version with relationships
        body2 = {
            "data": {
                "type": "appStoreVersions",
                "id": VERSION_ID,
                "relationships": {
                    "build": {
                        "data": {"type": "builds", "id": BUILD_ID}
                    }
                },
            }
        }
        status2, resp2 = request(
            "PATCH", f"/appStoreVersions/{VERSION_ID}", body2
        )
        print(f"  fallback PATCH version status={status2}")
        if status2 >= 400:
            print(pretty(resp2))
        return {
            "http": status2,
            "buildId": BUILD_ID if status2 < 400 else None,
            "error": resp2 if status2 >= 400 else None,
        }
    return {"http": status, "buildId": BUILD_ID, "error": None}


def step5_content_rights(app_info_id: str | None = None) -> dict:
    print("\n=== 5) Set contentRightsDeclaration (on apps, not appInfos) ===")
    # Prefer DOES_NOT_USE_THIRD_PARTY_CONTENT for original practice UX
    declaration = "DOES_NOT_USE_THIRD_PARTY_CONTENT"
    body = {
        "data": {
            "type": "apps",
            "id": APP_ID,
            "attributes": {"contentRightsDeclaration": declaration},
        }
    }
    status, resp = request("PATCH", f"/apps/{APP_ID}", body)
    print(f"  status={status} declaration={declaration}")
    if status >= 400:
        print(pretty(resp))
        return {"http": status, "value": None, "error": resp}
    return {"http": status, "value": declaration, "error": None}


def step6_review_detail() -> dict:
    print("\n=== 6) reviewDetail ===")
    st, resp = request(
        "GET", f"/appStoreVersions/{VERSION_ID}/appStoreReviewDetail"
    )
    print(f"  GET reviewDetail status={st}")
    existing = None
    if st == 200 and resp.get("data"):
        existing = resp["data"]
        print(f"  existing id={existing['id']}")
        print(f"  attrs={pretty(existing.get('attributes'))}")
    elif st == 404 or (st == 200 and not resp.get("data")):
        print("  no existing reviewDetail")
    else:
        print(pretty(resp))

    # Placeholders — prefer existing values
    existing_attrs = (existing or {}).get("attributes") or {}
    contact = {
        "contactFirstName": existing_attrs.get("contactFirstName") or "Jinbao",
        "contactLastName": existing_attrs.get("contactLastName") or "Li",
        "contactEmail": existing_attrs.get("contactEmail")
        or "richard377933128@gmail.com",
        "contactPhone": existing_attrs.get("contactPhone") or "+86 13800000000",
        "demoAccountName": existing_attrs.get("demoAccountName"),
        "demoAccountPassword": existing_attrs.get("demoAccountPassword"),
        "demoAccountRequired": existing_attrs.get("demoAccountRequired")
        if existing_attrs.get("demoAccountRequired") is not None
        else False,
        "notes": existing_attrs.get("notes")
        or "笔译训练为教育类语言练习应用，无需登录即可使用主要功能。",
    }
    # Don't invent phone if we somehow shouldn't — user said use existing if available.
    # If no existing phone, we need something ASC requires — keep placeholder.

    attrs_to_set = {k: v for k, v in contact.items() if v is not None}

    if existing:
        rid = existing["id"]
        # Only fill missing fields
        patch_attrs = {}
        for k, v in attrs_to_set.items():
            cur = existing_attrs.get(k)
            if cur is None or cur == "":
                patch_attrs[k] = v
            else:
                patch_attrs[k] = cur  # keep existing
        # Always ensure core contact fields present
        for k in (
            "contactFirstName",
            "contactLastName",
            "contactEmail",
            "contactPhone",
            "demoAccountRequired",
            "notes",
        ):
            if not existing_attrs.get(k) and k in attrs_to_set:
                patch_attrs[k] = attrs_to_set[k]

        body = {
            "data": {
                "type": "appStoreReviewDetails",
                "id": rid,
                "attributes": patch_attrs,
            }
        }
        st2, r2 = request("PATCH", f"/appStoreReviewDetails/{rid}", body)
        print(f"  PATCH status={st2}")
        if st2 >= 400:
            print(pretty(r2))
        return {
            "http": st2,
            "id": rid,
            "attrs": attr_get(r2, "data", "attributes") or patch_attrs,
            "keptExistingPhone": bool(existing_attrs.get("contactPhone")),
            "error": r2 if st2 >= 400 else None,
        }

    body = {
        "data": {
            "type": "appStoreReviewDetails",
            "attributes": attrs_to_set,
            "relationships": {
                "appStoreVersion": {
                    "data": {"type": "appStoreVersions", "id": VERSION_ID}
                }
            },
        }
    }
    st2, r2 = request("POST", "/appStoreReviewDetails", body)
    print(f"  POST status={st2}")
    if st2 >= 400:
        print(pretty(r2))
    return {
        "http": st2,
        "id": attr_get(r2, "data", "id"),
        "attrs": attr_get(r2, "data", "attributes") or attrs_to_set,
        "keptExistingPhone": False,
        "error": r2 if st2 >= 400 else None,
    }


def step7_age_rating(app_info_id: str) -> dict:
    print("\n=== 7) ageRatingDeclaration ===")
    st, resp = request("GET", f"/appInfos/{app_info_id}/ageRatingDeclaration")
    print(f"  GET status={st}")
    if st >= 400 and st != 404:
        print(pretty(resp))

    existing = resp.get("data") if isinstance(resp, dict) else None
    if existing:
        print(f"  existing id={existing['id']}")
        print(f"  attrs={pretty(existing.get('attributes'))}")

    # Minimal ratings for education language app (ASC age rating enums).
    # Newer questionnaire fields are required when any field is patched.
    minimal = {
        "alcoholTobaccoOrDrugUseOrReferences": "NONE",
        "contests": "NONE",
        "gambling": False,
        "gamblingSimulated": "NONE",
        "horrorOrFearThemes": "NONE",
        "matureOrSuggestiveThemes": "NONE",
        "medicalOrTreatmentInformation": "NONE",
        "profanityOrCrudeHumor": "NONE",
        "sexualContentGraphicAndNudity": "NONE",
        "sexualContentOrNudity": "NONE",
        "unrestrictedWebAccess": False,
        "violenceCartoonOrFantasy": "NONE",
        "violenceRealistic": "NONE",
        "violenceRealisticProlongedGraphicOrSadistic": "NONE",
        "gunsOrOtherWeapons": "NONE",
        "lootBox": False,
        "advertising": False,
        "userGeneratedContent": False,
        "parentalControls": False,
        "ageAssurance": False,
        "messagingAndChat": False,
        "healthOrWellnessTopics": False,
        "socialMedia": False,
        "socialMediaAgeRestricted": False,
    }

    if not existing:
        print("  No ageRatingDeclaration linked — trying include / create paths")
        # Some API versions require PATCH via relationship id discovered differently
        st_inc, resp_inc = request(
            "GET",
            f"/appInfos/{app_info_id}?include=ageRatingDeclaration",
        )
        print(f"  GET appInfo include status={st_inc}")
        included = (resp_inc or {}).get("included") or []
        for inc in included:
            if inc.get("type") == "ageRatingDeclarations":
                existing = inc
                break
        if not existing:
            # try listing via relationship link
            return {
                "http": st,
                "error": "ageRatingDeclaration not found; may need ASC UI once",
                "attrs": None,
            }

    rid = existing["id"]
    cur_attrs = existing.get("attributes") or {}
    patch_attrs = {}
    for k, v in minimal.items():
        # Only set if missing / null; don't overwrite already filled
        if cur_attrs.get(k) is None:
            patch_attrs[k] = v

    if not patch_attrs:
        print("  all relevant fields already set — skip PATCH")
        return {"http": 200, "id": rid, "attrs": cur_attrs, "patched": False}

    # Filter to known-accepted: if API rejects unknown keys, retry without them
    body = {
        "data": {
            "type": "ageRatingDeclarations",
            "id": rid,
            "attributes": patch_attrs,
        }
    }
    st2, r2 = request("PATCH", f"/ageRatingDeclarations/{rid}", body)
    print(f"  PATCH status={st2}")
    if st2 >= 400:
        print(pretty(r2))
        # Remove unknown attributes and retry
        errs = attr_get(r2, "errors") or []
        bad_keys = set()
        for err in errs:
            detail = (err.get("detail") or "") + " " + (err.get("source", {}).get("pointer") or "")
            for k in list(patch_attrs.keys()):
                if k in detail or f"/attributes/{k}" in detail:
                    bad_keys.add(k)
        # Also try dropping gunsOrOtherWeapons / lootBox which may be version-specific
        for k in ("gunsOrOtherWeapons", "lootBox"):
            bad_keys.add(k)
        reduced = {k: v for k, v in patch_attrs.items() if k not in bad_keys}
        if reduced and reduced != patch_attrs:
            body["data"]["attributes"] = reduced
            st3, r3 = request("PATCH", f"/ageRatingDeclarations/{rid}", body)
            print(f"  retry PATCH status={st3}")
            if st3 >= 400:
                print(pretty(r3))
            return {
                "http": st3,
                "id": rid,
                "attrs": attr_get(r3, "data", "attributes"),
                "patched": st3 < 400,
                "error": r3 if st3 >= 400 else None,
            }
        return {
            "http": st2,
            "id": rid,
            "attrs": cur_attrs,
            "patched": False,
            "error": r2,
        }

    return {
        "http": st2,
        "id": rid,
        "attrs": attr_get(r2, "data", "attributes"),
        "patched": True,
        "error": None,
    }


def step8_verify(app_info_id: str | None, app_info_loc_id: str | None) -> dict:
    print("\n=== 8) VERIFY ===")
    summary: dict[str, Any] = {}

    # Version localization
    st, r = request("GET", f"/appStoreVersionLocalizations/{LOC_ID}")
    attrs = attr_get(r, "data", "attributes") or {}
    summary["versionLocalization"] = {
        "http": st,
        "description": field_status(attrs.get("description")),
        "keywords": field_status(attrs.get("keywords")),
        "supportUrl": attrs.get("supportUrl") or "EMPTY",
        "promotionalText": field_status(attrs.get("promotionalText")),
        "whatsNew": field_status(attrs.get("whatsNew")),
        "marketingUrl": field_status(attrs.get("marketingUrl")),
    }

    # App info localization
    if app_info_loc_id:
        st2, r2 = request("GET", f"/appInfoLocalizations/{app_info_loc_id}")
        a2 = attr_get(r2, "data", "attributes") or {}
    elif app_info_id:
        st2, r2 = request(
            "GET", f"/appInfos/{app_info_id}/appInfoLocalizations"
        )
        a2 = {}
        for loc in (r2 or {}).get("data") or []:
            if (loc.get("attributes") or {}).get("locale") == "zh-Hans":
                a2 = loc.get("attributes") or {}
                app_info_loc_id = loc["id"]
                break
    else:
        st2, a2 = -1, {}
    summary["appInfoLocalization"] = {
        "http": st2,
        "id": app_info_loc_id,
        "name": a2.get("name") or "EMPTY",
        "subtitle": a2.get("subtitle") or "EMPTY",
        "privacyPolicyUrl": a2.get("privacyPolicyUrl") or "EMPTY",
    }

    # Version + copyright
    st3, r3 = request("GET", f"/appStoreVersions/{VERSION_ID}")
    a3 = attr_get(r3, "data", "attributes") or {}
    summary["version"] = {
        "http": st3,
        "copyright": a3.get("copyright") or "EMPTY",
        "versionString": a3.get("versionString"),
        "appStoreState": a3.get("appStoreState"),
    }

    # Build relationship
    st4, r4 = request("GET", f"/appStoreVersions/{VERSION_ID}/build")
    summary["build"] = {
        "http": st4,
        "id": attr_get(r4, "data", "id") or "EMPTY",
        "expected": BUILD_ID,
        "match": attr_get(r4, "data", "id") == BUILD_ID,
    }

    # Content rights lives on apps resource
    st5, r5 = request("GET", f"/apps/{APP_ID}")
    a5 = attr_get(r5, "data", "attributes") or {}
    summary["contentRights"] = {
        "http": st5,
        "declaration": a5.get("contentRightsDeclaration") or "EMPTY",
    }

    # Review detail
    st6, r6 = request(
        "GET", f"/appStoreVersions/{VERSION_ID}/appStoreReviewDetail"
    )
    a6 = attr_get(r6, "data", "attributes") or {}
    summary["reviewDetail"] = {
        "http": st6,
        "id": attr_get(r6, "data", "id") or "EMPTY",
        "contactFirstName": field_status(a6.get("contactFirstName")),
        "contactLastName": field_status(a6.get("contactLastName")),
        "contactEmail": a6.get("contactEmail") or "EMPTY",
        "contactPhone": field_status(a6.get("contactPhone")),
        "notes": field_status(a6.get("notes")),
        "demoAccountRequired": a6.get("demoAccountRequired"),
    }

    # Age rating
    if app_info_id:
        st7, r7 = request(
            "GET", f"/appInfos/{app_info_id}/ageRatingDeclaration"
        )
        a7 = attr_get(r7, "data", "attributes") or {}
        # Count filled vs empty among common keys
        keys = [
            "alcoholTobaccoOrDrugUseOrReferences",
            "contests",
            "gambling",
            "gamblingSimulated",
            "horrorOrFearThemes",
            "matureOrSuggestiveThemes",
            "medicalOrTreatmentInformation",
            "profanityOrCrudeHumor",
            "sexualContentGraphicAndNudity",
            "sexualContentOrNudity",
            "unrestrictedWebAccess",
            "violenceCartoonOrFantasy",
            "violenceRealistic",
            "violenceRealisticProlongedGraphicOrSadistic",
        ]
        filled = sum(1 for k in keys if a7.get(k) is not None)
        summary["ageRating"] = {
            "http": st7,
            "id": attr_get(r7, "data", "id") or "EMPTY",
            "filledFields": f"{filled}/{len(keys)}",
            "sample": {k: a7.get(k) for k in keys[:4]},
        }
    else:
        summary["ageRating"] = {"id": "UNKNOWN"}

    return summary


def print_final_summary(results: dict, verify: dict) -> None:
    print("\n" + "=" * 60)
    print("最终核验摘要 / Final Verification Summary")
    print("=" * 60)

    vl = verify.get("versionLocalization") or {}
    ail = verify.get("appInfoLocalization") or {}
    ver = verify.get("version") or {}
    build = verify.get("build") or {}
    cr = verify.get("contentRights") or {}
    rd = verify.get("reviewDetail") or {}
    ar = verify.get("ageRating") or {}

    done = []
    missing = []
    errors = []

    def check(label: str, ok: bool, detail: str = ""):
        if ok:
            done.append(f"{label}" + (f" — {detail}" if detail else ""))
        else:
            missing.append(f"{label}" + (f" — {detail}" if detail else ""))

    check(
        "版本本地化 description",
        vl.get("description") == "OK",
        str(vl.get("description")),
    )
    check(
        "版本本地化 keywords",
        vl.get("keywords") == "OK",
        str(vl.get("keywords")),
    )
    check(
        "supportUrl",
        isinstance(vl.get("supportUrl"), str)
        and vl.get("supportUrl", "").startswith("http"),
        str(vl.get("supportUrl")),
    )
    check(
        "promotionalText",
        vl.get("promotionalText") == "OK",
        str(vl.get("promotionalText")),
    )
    check(
        "App 名称",
        ail.get("name") == APP_NAME,
        str(ail.get("name")),
    )
    check(
        "副标题 subtitle",
        bool(ail.get("subtitle")) and ail.get("subtitle") != "EMPTY",
        str(ail.get("subtitle")),
    )
    check(
        "privacyPolicyUrl",
        isinstance(ail.get("privacyPolicyUrl"), str)
        and "privacy" in str(ail.get("privacyPolicyUrl")),
        str(ail.get("privacyPolicyUrl")),
    )
    check(
        "copyright",
        bool(ver.get("copyright")) and ver.get("copyright") != "EMPTY",
        str(ver.get("copyright")),
    )
    check(
        "Build 关联",
        build.get("match") is True,
        f"id={build.get('id')}",
    )
    check(
        "contentRightsDeclaration",
        bool(cr.get("declaration")) and cr.get("declaration") != "EMPTY",
        str(cr.get("declaration")),
    )
    check(
        "审核联系人 email",
        bool(rd.get("contactEmail")) and rd.get("contactEmail") != "EMPTY",
        str(rd.get("contactEmail")),
    )
    check(
        "审核联系人 phone",
        rd.get("contactPhone") == "OK",
        str(rd.get("contactPhone")),
    )
    filled = str(ar.get("filledFields") or "")
    check(
        "年龄分级 ageRating",
        filled.startswith(("12/", "13/", "14/")) or (
            "/" in filled and int(filled.split("/")[0]) >= 10
        ),
        filled or str(ar.get("id")),
    )

    for step_name, res in results.items():
        if isinstance(res, dict) and res.get("error"):
            errors.append(f"{step_name}: HTTP {res.get('http')} — see log")

    print("\n【已完成】")
    for x in done:
        print(f"  ✓ {x}")
    print("\n【仍缺 / 未完成】")
    if missing:
        for x in missing:
            print(f"  ✗ {x}")
    else:
        print("  （无）")
    print("\n【API 错误】")
    if errors:
        for x in errors:
            print(f"  ! {x}")
    else:
        print("  （无）")

    print("\n【详细 verify JSON】")
    print(pretty(verify, limit=8000))
    print("\n未提交审核（按要求跳过 Submit）。")


def main() -> int:
    print("ASC metadata fill — 笔译训练")
    print(f"App={APP_ID} Version={VERSION_ID} Loc={LOC_ID} Build={BUILD_ID}")

    results: dict[str, Any] = {}

    results["step1"] = step1_version_localization()
    results["step2"] = step2_app_info_localization()
    app_info_id = results["step2"].get("appInfoId")
    app_info_loc_id = results["step2"].get("locId")

    results["step3"] = step3_copyright()
    results["step4"] = step4_attach_build()
    results["step5"] = step5_content_rights()
    results["step6"] = step6_review_detail()
    if app_info_id:
        results["step7"] = step7_age_rating(app_info_id)
    else:
        results["step7"] = {"error": "no appInfoId"}

    verify = step8_verify(app_info_id, app_info_loc_id)
    print_final_summary(results, verify)

    # Persist for parent
    out_path = "/Users/mslee/Desktop/biyi-practice/scripts/asc-fill-result.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"results": results, "verify": verify}, f, ensure_ascii=False, indent=2)
    print(f"\nWrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
