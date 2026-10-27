"""Nougan Duration -> Frames.

One node that replaces the "Float (duration)" + "Math Expression" pair: type a duration in
seconds, pick a preset (MiniMax H3 / 24 FPS / 30 FPS) or write your own expression, get frames.

Pairs with web/nougan_duration_frames.js, which adds the lock / unlock button, the live preview
and the sample table. The preview calls /nougan/duration_frames/eval, which uses the very same
evaluator as the node, so what you see is what runs.

Expression variables:  a (= duration in seconds), fps
Expression functions:  max min round abs ceil floor int float sqrt
Operators:             + - * / // % **  and  < <= > >= == !=,  and/or/not,  x if c else y
"""

import ast
import math
import operator

TAG = "[Nougan]"

# MiniMax H3 only accepts lengths of 17n + 5 frames (5, 22, 39, ...). Keep this string verbatim.
MINIMAX_EXPR = "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17"
CUSTOM = "Custom"

# name -> fps + expression. Non-custom presets always run their own expression, whatever the text box says.
PRESETS = {
    "MiniMax H3 (24 FPS)": {"fps": 24, "expression": MINIMAX_EXPR},
    "24 FPS":              {"fps": 24, "expression": "max(1, round(a * fps))"},
    "30 FPS":              {"fps": 30, "expression": "max(1, round(a * fps))"},
    CUSTOM:                None,
}
DEFAULT_PRESET = "MiniMax H3 (24 FPS)"

MAX_EXPR_LEN = 300
MAX_NODES = 200
MAX_POW = 64
MAX_BITS = 256          # largest integer the evaluator will ever hold or produce (about 1e77)
MAX_FRAMES = 1_000_000


# ---------------------------------------------------------------------------- safe evaluator

def _pow(x, y):
    if abs(y) > MAX_POW:
        raise ValueError("exponent too large")
    # Bound the size of an integer result *before* computing it. A cap on the exponent alone is not
    # enough: ((9**64)**64)**64 ... stays within it at every step while the number grows exponentially.
    if isinstance(x, int) and isinstance(y, int) and y > 0 and abs(x).bit_length() * y > MAX_BITS:
        raise ValueError("number too large")
    return x ** y


def _check(value):
    """Every value the evaluator produces goes through here, so no operand or intermediate can get big."""
    if isinstance(value, complex):
        raise ValueError("result is not a real number")
    if isinstance(value, int) and value.bit_length() > MAX_BITS:
        raise ValueError("number too large")
    return value


_BIN = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod, ast.Pow: _pow,
}
_UNARY = {ast.UAdd: operator.pos, ast.USub: operator.neg, ast.Not: operator.not_}
_CMP = {
    ast.Lt: operator.lt, ast.LtE: operator.le, ast.Gt: operator.gt, ast.GtE: operator.ge,
    ast.Eq: operator.eq, ast.NotEq: operator.ne,
}
_FUNCS = {
    "max": max, "min": min, "round": round, "abs": abs, "ceil": math.ceil, "floor": math.floor,
    "int": int, "float": float, "sqrt": math.sqrt,
}
_CONSTS = {"pi": math.pi, "e": math.e}


def _walk(node, env, budget):
    return _check(_walk_node(node, env, budget))


def _walk_node(node, env, budget):
    budget[0] += 1
    if budget[0] > MAX_NODES:
        raise ValueError("expression too complex")

    if isinstance(node, ast.Expression):
        return _walk(node.body, env, budget)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (int, float, bool)):
            return node.value
        raise ValueError("only numbers are allowed")
    if isinstance(node, ast.Name):
        if node.id in env:
            return env[node.id]
        if node.id in _CONSTS:
            return _CONSTS[node.id]
        raise ValueError(f"unknown name '{node.id}' (use a, fps)")
    if isinstance(node, ast.BinOp) and type(node.op) in _BIN:
        return _BIN[type(node.op)](_walk(node.left, env, budget), _walk(node.right, env, budget))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY:
        return _UNARY[type(node.op)](_walk(node.operand, env, budget))
    if isinstance(node, ast.Compare):
        left = _walk(node.left, env, budget)
        for op, comp in zip(node.ops, node.comparators):
            if type(op) not in _CMP:
                raise ValueError("unsupported comparison")
            right = _walk(comp, env, budget)
            if not _CMP[type(op)](left, right):
                return False
            left = right
        return True
    if isinstance(node, ast.BoolOp):
        values = [_walk(v, env, budget) for v in node.values]
        return all(values) if isinstance(node.op, ast.And) else any(values)
    if isinstance(node, ast.IfExp):
        return _walk(node.body if _walk(node.test, env, budget) else node.orelse, env, budget)
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in _FUNCS:
            raise ValueError("unknown function (allowed: " + ", ".join(_FUNCS) + ")")
        if node.keywords or len(node.args) > 3:
            raise ValueError("bad function arguments")
        return _FUNCS[node.func.id](*[_walk(a, env, budget) for a in node.args])
    raise ValueError("unsupported syntax")


def evaluate(expression, a, fps):
    """Evaluate `expression` with a = seconds, fps = frame rate. Raises ValueError with a readable message."""
    expression = (expression or "").strip()
    if not expression:
        raise ValueError("expression is empty")
    if len(expression) > MAX_EXPR_LEN:
        raise ValueError("expression too long")
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as error:
        raise ValueError(f"syntax error: {error.msg}")
    try:
        return _walk(tree, {"a": a, "fps": fps}, [0])
    except ZeroDivisionError:
        raise ValueError("division by zero")
    except (ArithmeticError, TypeError) as error:
        raise ValueError(str(error) or "math error")


def to_frames(expression, a, fps):
    """Expression result -> integer frame count (floats are rounded, minimum 1)."""
    value = evaluate(expression, a, fps)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("result is not a finite number")
        value = round(value)
    frames = int(value)
    if frames > MAX_FRAMES:
        raise ValueError("result is unreasonably large")
    return max(1, frames)


def resolve(preset, expression, fps):
    """Same rule everywhere: a real preset wins over the text box, Custom uses the text box."""
    spec = PRESETS.get(preset)
    if spec:
        return spec["expression"], int(spec["fps"])
    return expression, max(1, int(fps))


# ---------------------------------------------------------------------------- node

class NouganDurationFrames:
    CATEGORY = "Nougan"
    FUNCTION = "run"
    RETURN_TYPES = ("INT", "FLOAT", "INT")
    RETURN_NAMES = ("frames", "seconds", "fps")
    DESCRIPTION = (
        "Duration in seconds -> frame count. Presets for MiniMax H3 (17n+5 frames at 24 FPS) and plain "
        "24 / 30 FPS, or unlock the expression and write your own (variables: a = seconds, fps)."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "duration": ("FLOAT", {
                    "default": 6.0, "min": 0.0, "max": 3600.0, "step": 0.1, "round": 0.001,
                    "tooltip": "Length in seconds. Available to the expression as 'a'.",
                }),
                "preset": (list(PRESETS.keys()), {
                    "default": DEFAULT_PRESET,
                    "tooltip": "Presets always run their own expression. Pick Custom to use your own.",
                }),
                "expression": ("STRING", {
                    "default": MINIMAX_EXPR, "multiline": True,
                    "tooltip": "Locked by default. Unlock it in the node to edit; editing switches the preset to Custom.",
                }),
                "fps": ("INT", {
                    "default": 24, "min": 1, "max": 240,
                    "tooltip": "Only used by Custom (available to the expression as 'fps'). Presets set their own.",
                }),
            }
        }

    def run(self, duration, preset, expression, fps):
        expr, rate = resolve(preset, expression, fps)
        try:
            frames = to_frames(expr, float(duration), rate)
        except ValueError as error:
            raise ValueError(f"{TAG} Duration -> Frames: {error}  [expression: {expr}]")
        seconds = frames / rate
        info = {"duration": float(duration), "frames": frames, "seconds": seconds, "fps": rate, "expression": expr}
        return {"ui": {"nougan_duration_frames": [info]}, "result": (frames, seconds, rate)}


# ---------------------------------------------------------------------------- routes (live preview)

def _preview_rows(body):
    expr, rate = resolve(body.get("preset", CUSTOM), str(body.get("expression", "")), body.get("fps", 24))
    rows = []
    for raw in list(body.get("values", []))[:40]:
        try:
            a = float(raw)
            frames = to_frames(expr, a, rate)
            rows.append({"a": a, "frames": frames, "seconds": frames / rate})
        except (ValueError, TypeError) as error:
            rows.append({"a": raw, "error": str(error)})
    return {"fps": rate, "expression": expr, "rows": rows}


def _register_routes():
    try:
        from aiohttp import web
        from server import PromptServer

        routes = PromptServer.instance.routes

        @routes.get("/nougan/duration_frames/presets")
        async def _presets(_request):
            return web.json_response({k: v for k, v in PRESETS.items() if v})

        @routes.post("/nougan/duration_frames/eval")
        async def _eval(request):
            try:
                body = await request.json()
            except Exception:
                return web.json_response({"error": "bad request"}, status=400)
            return web.json_response(_preview_rows(body if isinstance(body, dict) else {}))
    except Exception as error:  # outside ComfyUI, or the route already exists
        print(f"{TAG} Duration -> Frames: could not register routes ({error})")


_register_routes()
