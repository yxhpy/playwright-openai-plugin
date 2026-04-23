#!/usr/bin/env python3
"""Search the bundled GPT Image 2 prompt catalogue."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


CATALOG_PATH = Path(__file__).resolve().parents[1] / "references" / "prompt_catalog.json"
CJK_RE = re.compile(r"[\u3400-\u9fff]")
WORD_RE = re.compile(r"[a-z0-9][a-z0-9._/-]*")

EXTRA_SYNONYMS = {
    "电商": ["ecommerce", "product", "商品", "主图"],
    "主图": ["ecommerce", "main image", "product"],
    "海报": ["poster", "marketing", "flyer"],
    "头像": ["avatar", "profile", "portrait", "selfie"],
    "封面": ["thumbnail", "cover", "youtube"],
    "信息图": ["infographic", "diagram", "education"],
    "分镜": ["storyboard", "comic", "panel"],
    "漫画": ["comic", "manga", "storyboard"],
    "像素": ["pixel", "game", "asset"],
    "产品": ["product", "marketing", "ecommerce"],
    "文字": ["typography", "text", "poster"],
    "排版": ["typography", "layout", "text"],
    "摄影": ["photo", "photography", "realistic"],
    "写实": ["realistic", "photography", "photo"],
    "角色": ["character", "mascot", "game"],
    "游戏": ["game", "asset", "sprite"],
    "社媒": ["social", "post", "card"],
}


def load_catalog() -> dict:
    try:
        return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"catalog not found: {CATALOG_PATH}") from None
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid catalog JSON: {exc}") from None


def detect_language(text: str) -> str:
    return "zh" if CJK_RE.search(text) else "en"


def norm(text: object) -> str:
    if text is None:
        return ""
    return str(text).lower()


def field(record: dict, base: str, language: str) -> str:
    preferred = record.get(f"{base}_{language}")
    fallback = record.get(f"{base}_{'en' if language == 'zh' else 'zh'}")
    return preferred or fallback or ""


def category_lookup(catalog: dict) -> dict[str, dict]:
    return {category["slug"]: category for category in catalog["categories"]}


def query_terms(query: str, catalog: dict) -> tuple[list[str], list[str]]:
    lowered = norm(query)
    terms: list[str] = []
    category_hits: list[str] = []

    for word in WORD_RE.findall(lowered):
        if len(word) > 1:
            terms.append(word)

    cjk_chunks = re.findall(r"[\u3400-\u9fff]{2,}", query)
    terms.extend(cjk_chunks)

    for key, values in EXTRA_SYNONYMS.items():
        if key.lower() in lowered:
            terms.extend(values)

    for category in catalog["categories"]:
        names = [
            category.get("slug", ""),
            category.get("name_en", ""),
            category.get("name_zh", ""),
            *(category.get("aliases") or []),
        ]
        if any(norm(name) and norm(name) in lowered for name in names):
            category_hits.append(category["slug"])
            terms.extend(names)

    deduped_terms = []
    seen = set()
    for term in terms:
        term = norm(term).strip()
        if term and term not in seen:
            seen.add(term)
            deduped_terms.append(term)
    return deduped_terms, sorted(set(category_hits))


def score_record(record: dict, query: str, language: str, terms: list[str], category_hits: list[str]) -> float:
    q = norm(query).strip()
    title = norm(field(record, "title", language))
    item_title = norm(field(record, "item_title", language))
    description = norm(field(record, "description", language))
    prompt = norm(field(record, "prompt", language))
    category = norm(record.get(f"category_{language}") or record.get("category_en"))
    searchable = " ".join([title, item_title, description, category])

    score = 0.0
    if record.get("category_slug") in category_hits:
        score += 40.0
    if q and q in title:
        score += 24.0
    if q and q in description:
        score += 12.0
    if q and q in prompt:
        score += 4.0
    if record.get("featured"):
        score += 1.5
    if record.get("raycast_friendly"):
        score += 0.5

    for term in terms:
        if term in title:
            score += 9.0
        if term in item_title:
            score += 7.0
        if term in category:
            score += 8.0
        if term in description:
            score += 4.0
        if term in prompt:
            score += 1.0
        if term in searchable:
            score += 1.0
    return score


def summarize_prompt(text: str, limit: int = 220) -> str:
    compact = re.sub(r"\s+", " ", text.strip())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1].rstrip() + "..."


def result_record(record: dict, language: str, include_prompt: bool) -> dict:
    result = {
        "id": record["id"],
        "score": round(record.get("_score", 0.0), 2),
        "category": {
            "slug": record["category_slug"],
            "name": record.get(f"category_{language}") or record.get("category_en"),
        },
        "title": field(record, "title", language),
        "description": field(record, "description", language),
        "raycast_friendly": bool(record.get("raycast_friendly")),
        "source": {
            "author": record.get("author"),
            "source_url": record.get("source_url"),
            "try_url": record.get(f"try_url_{language}") or record.get("try_url_en"),
        },
        "prompt_preview": summarize_prompt(field(record, "prompt", language)),
    }
    if include_prompt:
        result["prompt"] = field(record, "prompt", language)
    return result


def search(catalog: dict, query: str, language: str, limit: int, include_prompt: bool) -> dict:
    if language == "auto":
        language = detect_language(query)
    terms, category_hits = query_terms(query, catalog)
    scored = []
    for record in catalog["prompts"]:
        scored_record = dict(record)
        scored_record["_score"] = score_record(record, query, language, terms, category_hits)
        if scored_record["_score"] > 0:
            scored.append(scored_record)
    scored.sort(key=lambda item: (item["_score"], item.get("featured", False)), reverse=True)
    return {
        "query": query,
        "language": language,
        "terms": terms,
        "matched_categories": category_hits,
        "source": catalog["source"],
        "results": [result_record(record, language, include_prompt) for record in scored[:limit]],
    }


def show(catalog: dict, prompt_id: str, language: str, output_format: str) -> int:
    if language == "auto":
        language = "en"
    record = next((item for item in catalog["prompts"] if item["id"] == prompt_id), None)
    if not record:
        print(f"prompt not found: {prompt_id}", file=sys.stderr)
        return 2
    result = result_record(record, language, include_prompt=True)
    result["source_catalog"] = catalog["source"]
    if output_format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    print(f"# {result['title']}")
    print()
    print(f"- id: {result['id']}")
    print(f"- category: {result['category']['name']} ({result['category']['slug']})")
    if result["source"].get("author"):
        print(f"- author: {result['source']['author']}")
    if result["source"].get("try_url"):
        print(f"- try: {result['source']['try_url']}")
    print(f"- attribution: {catalog['source']['attribution']}")
    print()
    print(result["description"])
    print()
    print("```")
    print(result["prompt"])
    print("```")
    return 0


def categories(catalog: dict, language: str, output_format: str) -> int:
    if language == "auto":
        language = "en"
    rows = []
    counts: dict[str, int] = {}
    for record in catalog["prompts"]:
        counts[record["category_slug"]] = counts.get(record["category_slug"], 0) + 1
    for category in catalog["categories"]:
        rows.append(
            {
                "slug": category["slug"],
                "name": category.get(f"name_{language}") or category.get("name_en"),
                "group": category.get(f"group_{language}") or category.get("group_en"),
                "prompt_count": counts.get(category["slug"], 0),
                "aliases": category.get("aliases", []),
            }
        )
    if output_format == "json":
        print(json.dumps({"source": catalog["source"], "categories": rows}, ensure_ascii=False, indent=2))
        return 0
    for row in rows:
        print(f"{row['slug']}\t{row['name']}\t{row['prompt_count']}")
    return 0


def route(catalog: dict, query: str, language: str, limit: int) -> dict:
    routed = search(catalog, query, language, limit, include_prompt=False)
    category_names = category_lookup(catalog)
    routed["routing_guidance"] = [
        "Use the top result as a structural pattern, not as a mandatory copy.",
        "Keep useful JSON/layout/placeholders from the source prompt when they match the user request.",
        "Fill Raycast-style {argument ...} placeholders only when the user supplied the values.",
        "Preserve source attribution if reusing substantial prompt text.",
    ]
    routed["matched_category_names"] = [
        {
            "slug": slug,
            "name": category_names.get(slug, {}).get(f"name_{routed['language']}")
            or category_names.get(slug, {}).get("name_en")
            or slug,
        }
        for slug in routed["matched_categories"]
    ]
    return routed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Route image ideas to bundled GPT Image 2 prompt examples.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    search_parser = subparsers.add_parser("search", help="Search prompt examples.")
    search_parser.add_argument("query")
    search_parser.add_argument("--language", choices=["auto", "en", "zh"], default="auto")
    search_parser.add_argument("--limit", type=int, default=5)
    search_parser.add_argument("--include-prompt", action="store_true")
    search_parser.add_argument("--json", action="store_true", default=True)

    route_parser = subparsers.add_parser("route", help="Return route guidance and top prompt examples.")
    route_parser.add_argument("query")
    route_parser.add_argument("--language", choices=["auto", "en", "zh"], default="auto")
    route_parser.add_argument("--limit", type=int, default=5)

    show_parser = subparsers.add_parser("show", help="Show one full prompt by id.")
    show_parser.add_argument("id")
    show_parser.add_argument("--language", choices=["auto", "en", "zh"], default="auto")
    show_parser.add_argument("--format", choices=["json", "markdown"], default="markdown")

    categories_parser = subparsers.add_parser("categories", help="List prompt categories.")
    categories_parser.add_argument("--language", choices=["auto", "en", "zh"], default="auto")
    categories_parser.add_argument("--format", choices=["json", "text"], default="text")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    catalog = load_catalog()
    if args.command == "search":
        print(json.dumps(search(catalog, args.query, args.language, args.limit, args.include_prompt), ensure_ascii=False, indent=2))
        return 0
    if args.command == "route":
        print(json.dumps(route(catalog, args.query, args.language, args.limit), ensure_ascii=False, indent=2))
        return 0
    if args.command == "show":
        return show(catalog, args.id, args.language, args.format)
    if args.command == "categories":
        return categories(catalog, args.language, args.format)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
