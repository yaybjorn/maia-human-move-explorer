"""Effective names for the private review; raw imports and revisions remain history."""
import json
import re

NAMES = {"Russell": "Steve", "Manning": "Mark", "Kay": "Beth"}
NAME_PATTERN = re.compile(r"\b(?:Russell|Manning|Kay)\b")


def renamed_text(value):
    return NAME_PATTERN.sub(lambda match: NAMES[match.group()], value)


def effective_course_script(script):
    prefix = "const COURSE="
    if not script.startswith(prefix):
        raise ValueError("Unexpected course script format")
    course, end = json.JSONDecoder().raw_decode(script[len(prefix):])

    def visit(value):
        if isinstance(value, list):
            for item in value:
                visit(item)
        elif isinstance(value, dict):
            for key, item in value.items():
                if key in {"title", "body"} and isinstance(item, str):
                    value[key] = renamed_text(item)
                elif isinstance(item, (dict, list)):
                    visit(item)

    visit(course)
    return prefix + json.dumps(course, ensure_ascii=True, separators=(",", ":")) + script[len(prefix) + end:]
