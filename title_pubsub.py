"""
title_pubsub
------------
A publisher/subscriber pair for sending a Text Editor (Minimax) node's title
to nodes that aren't wired to it:

    TitlePublisher   sits on a string path and passes the string through
                     unchanged. It has a name, which subscribers pick from.
    TitleSubscriber  sits anywhere and outputs the title of the editor node
                     feeding the publisher it's set to ("" if there is none).

The matching happens in the browser when the prompt is queued (see
web/title_pubsub/title_pubsub.js): each publisher walks back from its input
to the furthest TextEditorMinimax node, following the last text input
wherever the path splits, and that node's title is written into every
matching subscriber's "title" input. The publisher's name and subscriber's
channel are then removed from the queued prompt, so only the title itself
takes part in caching: renaming a publisher doesn't re-run anything.
"""

from comfy_api.latest import io


class TitlePublisher(io.ComfyNode):
    """Passes its text straight through; the frontend reads its name."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="CherryTitlePublisher",
            display_name="Title Publisher 🍒",
            category="utils/text",
            description=(
                "Passes text through unchanged, and sends the title of the "
                "Text Editor (Minimax) node feeding it to every Title "
                "Subscriber set to this publisher's name."
            ),
            search_aliases=["publisher", "publish", "pubsub", "broadcast", "channel", "title"],
            inputs=[
                io.String.Input("text", force_input=True, tooltip="Passed through unchanged."),
                # Optional because the frontend removes it from the queued
                # prompt once subscribers have been matched to it.
                io.String.Input(
                    "name",
                    default="prompt",
                    optional=True,
                    socketless=True,
                    tooltip=(
                        "Name subscribers pick this publisher by. A name "
                        "that's already taken gets a number added."
                    ),
                ),
            ],
            outputs=[
                io.String.Output(display_name="text"),
            ],
        )

    @classmethod
    def execute(cls, text: str, name: str = "") -> io.NodeOutput:
        return io.NodeOutput(text)


class TitleSubscriber(io.ComfyNode):
    """Outputs the title the frontend resolved for the chosen publisher."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="CherryTitleSubscriber",
            display_name="Title Subscriber 🍒",
            category="utils/text",
            description=(
                "Outputs the title of the Text Editor (Minimax) node feeding "
                "the chosen Title Publisher, or an empty string if there is "
                "none."
            ),
            search_aliases=["subscriber", "subscribe", "pubsub", "channel", "title"],
            inputs=[
                # The frontend fills the options with the current publisher
                # names, so the server-side list stays empty.
                io.Combo.Input(
                    "channel",
                    options=[],
                    default="",
                    optional=True,
                    socketless=True,
                    tooltip="Publisher to take the title from.",
                ),
            ],
            outputs=[
                io.String.Output(display_name="title"),
            ],
            # The resolved "title" arrives as an input that isn't in this
            # schema; the frontend adds it when the prompt is queued.
            accept_all_inputs=True,
        )

    @classmethod
    def validate_inputs(cls, channel: str = "") -> bool:
        # Publisher names only exist in the frontend, so skip the default
        # "value not in list" check against the empty options above.
        return True

    @classmethod
    def execute(cls, channel: str = "", title: str = "", **kwargs) -> io.NodeOutput:
        return io.NodeOutput(title)
