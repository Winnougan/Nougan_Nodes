# nougan_h3_duration.py — Nougan suite by Winnougan
#
# MiniMax H3 duration (seconds) -> frame count (INT).
# Default rule: snap to the H3 17n+5 frame grid at 24 FPS.
# The expression box is hidden until "edit_expression" is switched on (web/nougan_h3_duration.js).
# 'a' = seconds. Whatever is in the box always drives the result.

import ast
import math

DEFAULT_EXPRESSION = "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17"

_FUNCS = {
    "max": max, "min": min, "abs": abs, "round": round,
    "int": int, "float": float, "floor": math.floor, "ceil": math.ceil,
}

_BINOPS = {
    ast.Add: lambda x, y: x + y,
    ast.Sub: lambda x, y: x - y,
    ast.Mult: lambda x, y: x * y,
    ast.Div: lambda x, y: x / y,
    ast.FloorDiv: lambda x, y: x // y,
    ast.Mod: lambda x, y: x % y,
    ast.Pow: lambda x, y: x ** y,
}

_UNOPS = {ast.UAdd: lambda x: +x, ast.USub: lambda x: -x}


def _eval(node, a):
    if isinstance(node, ast.Expression):
        return _eval(node.body, a)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
            raise ValueError("only numbers are allowed")
        return node.value
    if isinstance(node, ast.Name):
        if node.id == "a":
            return a
        raise ValueError(f"unknown name '{node.id}' (only 'a' = seconds)")
    if isinstance(node, ast.BinOp) and type(node.op) in _BINOPS:
        return _BINOPS[type(node.op)](_eval(node.left, a), _eval(node.right, a))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNOPS:
        return _UNOPS[type(node.op)](_eval(node.operand, a))
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in _FUNCS:
            raise ValueError("allowed functions: " + ", ".join(sorted(_FUNCS)))
        if node.keywords:
            raise ValueError("keyword arguments are not allowed")
        return _FUNCS[node.func.id](*[_eval(arg, a) for arg in node.args])
    raise ValueError(f"unsupported syntax: {type(node).__name__}")


def evaluate(expression, seconds):
    return _eval(ast.parse(expression, mode="eval"), float(seconds))


class NouganH3Duration:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "duration": ("FLOAT", {"default": 5.0, "min": 0.0, "max": 3600.0, "step": 0.1}),
                "edit_expression": ("BOOLEAN", {"default": False}),
                "expression": ("STRING", {"default": DEFAULT_EXPRESSION, "multiline": True}),
            }
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("frames",)
    FUNCTION = "frames_for_duration"
    CATEGORY = "Nougan/Utils"
    DESCRIPTION = "MiniMax H3: seconds in, frame count out (17n+5 grid at 24 FPS)."

    def frames_for_duration(self, duration, edit_expression, expression):
        # edit_expression only shows/hides the box in the UI; the expression always drives the result.
        expr = (expression or "").strip() or DEFAULT_EXPRESSION
        try:
            frames = int(evaluate(expr, duration))
        except Exception as e:
            raise ValueError(f"[Nougan H3 Duration] bad expression {expr!r}: {e}") from None
        return (max(1, frames),)
