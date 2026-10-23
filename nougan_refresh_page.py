# nougan_refresh_page.py  —  Nougan Refresh Page by Winnougan
# UI-only node: one button that reloads the ComfyUI browser tab (see web/nougan_refresh_page.js).
# It has no inputs or outputs, so it never executes in the graph.


class NouganRefreshPage:
    CATEGORY = "Nougan"
    FUNCTION = "noop"
    RETURN_TYPES = ()

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    def noop(self):
        return ()


NODE_CLASS_MAPPINGS = {"NouganRefreshPage": NouganRefreshPage}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganRefreshPage": "Nougan Refresh Page 🔄"}
