# nougan_layout_llm.py
# Nougan Layout LLM Prompt
#
# Builds the system prompt + user prompt that make an LLM (ComfyUI's TextGenerate with the Qwen text
# encoder, LM Studio, etc.) answer with JSON that Nougan Bounding Boxes understands directly:
#
#   [{"type":"obj","bbox":[ymin,xmin,ymax,xmax],"desc":"..."},
#    {"type":"text","bbox":[...],"text":"WORDS","desc":"..."}]      (0-1000 grid)
#
# Wire:  this node -> system_prompt / prompt -> TextGenerate -> STRING -> Nougan Bounding Boxes "bboxes"


class NouganLayoutLLMPrompt:
    CATEGORY = "Nougan"
    FUNCTION = "build"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("system_prompt", "prompt")
    DESCRIPTION = ("Writes the instructions that make an LLM answer with bounding-box JSON. Connect system_prompt and "
                   "prompt to a TextGenerate (or any LLM node), then connect its text output to the 'bboxes' input "
                   "of Nougan Bounding Boxes.")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "scene": ("STRING", {"multiline": True,
                                     "default": "A poster with the headline \"SUMMER SALE\" at the top and a parrot flying at the bottom middle.",
                                     "tooltip": "Describe the image and where things go (top, bottom middle, left...)."}),
                "width": ("INT", {"default": 1024, "min": 16, "max": 16384, "step": 16,
                                  "tooltip": "Canvas width. Connect the same value you give Nougan Bounding Boxes."}),
                "height": ("INT", {"default": 1024, "min": 16, "max": 16384, "step": 16}),
                "max_boxes": ("INT", {"default": 5, "min": 1, "max": 16, "step": 1}),
            },
            "optional": {
                "extra_rules": ("STRING", {"multiline": True, "default": "",
                                           "tooltip": "Optional extra instructions, e.g. 'keep the bottom 15% empty'."}),
            },
        }

    def build(self, scene, width, height, max_boxes, extra_rules=""):
        gw, gh = width / 1000.0, height / 1000.0
        if width > height * 1.15:
            shape = "landscape (wider than tall)"
        elif height > width * 1.15:
            shape = "portrait (taller than wide)"
        else:
            shape = "roughly square"

        system = f"""You are a layout planner for a text-to-image model. Turn the user's scene description into a JSON array of boxes that place every important subject and every piece of text on the canvas.

Canvas: {width}x{height} pixels, {shape}. Coordinates are NOT pixels. They are integers on a 0-1000 grid in both directions: 0 is the top or left edge, 1000 is the bottom or right edge, 500 is the middle. One grid unit is {gw:.2f} px wide and {gh:.2f} px tall.

Each box is an object with these keys:
- "type": "obj" for a person, animal, object or scenery, or "text" for words that must be written in the image.
- "bbox": [ymin, xmin, ymax, xmax] = [top, left, bottom, right]. ymin must be smaller than ymax and xmin smaller than xmax.
- "text": only for "text" boxes. The exact words to write, copied from the request with the same capitalisation.
- "desc": a short visual description. For text boxes, describe the lettering (font style, colour, size).

Rules:
- Use at most {max_boxes} boxes. One box per subject and one per piece of text. Do not add a box for the plain background unless the user asks for it.
- Put things where the user says: "top" means a small ymin, "bottom" a large ymax, "left" a small xmin, "right" a large xmax, "middle" or "centre" around 500. If the user gives no position, compose it naturally.
- Draw each box tightly around its subject and keep it inside 0-1000. Text boxes should be wide and short so the words fit on one line.
- Only let boxes overlap when one thing really sits in front of another. List background things first and foreground things last.
- Answer with the JSON array only. No markdown, no code fences, no comments, no explanation.
{('- ' + extra_rules.strip()) if extra_rules and extra_rules.strip() else ''}
Example for "a cat on a sofa under the title HOME":
[{{"type":"text","bbox":[40,250,140,750],"text":"HOME","desc":"large white serif lettering"}},{{"type":"obj","bbox":[420,120,900,880],"desc":"a ginger cat curled up on a grey sofa"}}]"""

        prompt = f"Scene description:\n{scene.strip()}\n\nReturn the JSON array now."
        return (system.strip() + "\n", prompt)
