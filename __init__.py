from pathlib import Path
import sys

from typing_extensions import override
from comfy_api.latest import ComfyExtension, io
from .text_editor_minimax import TextEditorMinimax

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {
    "TextEditorMinimax": TextEditorMinimax
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "TextEditorMinimax": "Text Editor Minimax 🍒",
}


class CherryExtensionTextEditor(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [TextEditorMinimax]

async def comfy_entrypoint() -> CherryExtensionTextEditor:
    return CherryExtensionTextEditor()
