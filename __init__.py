from pathlib import Path
import sys

from typing_extensions import override
from comfy_api.latest import ComfyExtension, io
from .text_editor_minimax import TextEditorMinimax
from .title_pubsub import TitlePublisher, TitleSubscriber
from .modular_timeline import ModularTimeline

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {
    "TextEditorMinimax": TextEditorMinimax,
    "CherryTitlePublisher": TitlePublisher,
    "CherryTitleSubscriber": TitleSubscriber,
    "CherryModularTimeline": ModularTimeline,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "TextEditorMinimax": "Text Editor Minimax 🍒",
    "CherryTitlePublisher": "Title Publisher 🍒",
    "CherryTitleSubscriber": "Title Subscriber 🍒",
    "CherryModularTimeline": "Modular Timeline 🍒",
}


class CherryExtensionTextEditor(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [TextEditorMinimax, TitlePublisher, TitleSubscriber, ModularTimeline]

async def comfy_entrypoint() -> CherryExtensionTextEditor:
    return CherryExtensionTextEditor()
