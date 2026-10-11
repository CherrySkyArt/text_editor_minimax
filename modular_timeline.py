"""
modular_timeline
----------------
A ComfyUI node that retimes the "at <time>" markers in a string, using a
timeline widget (see web/modular_timeline/modular_timeline.js).

A marker is "at" followed by a time in seconds ("at 6.4") or in minutes and
seconds ("at 00:03.400"), in any case. Pressing Reset on the node reads its
input text and lays the markers out as the edges between blocks on a
timeline; dragging a marker changes its time, in steps of 0.1s.

The widget sends only the marker times, in order, as a JSON list of seconds
("[3.4, 6.4, 10.3]"). The n-th marker in the input text is rewritten to the
n-th time, keeping the "at" and the time's original format: "At 00:03.400"
moved to 2s becomes "At 00:02.000", and "at 6.4" becomes "at 2.0". Markers
past the end of the list are left as they are.
"""

import json
import logging
import re

from comfy_api.latest import io

# "at", spaces, then a time as seconds ("6.4") or minutes:seconds
# ("00:03.400"). Must match MARKER_RE in web/modular_timeline/modular_timeline.js.
MARKER_RE = re.compile(r"\b(at[ \t]+)(\d+:\d+\.\d+|\d+\.\d+)", re.IGNORECASE | re.ASCII)

# Input type the frontend draws as the timeline. Must match TIMELINE_TYPE in
# the JS.
Timeline = io.Custom("CHERRY_TIMELINE")


def parse_timeline(value) -> list[int]:
    """Marker times from the widget, in tenths of a second."""
    try:
        if isinstance(value, str):
            value = json.loads(value) if value.strip() else []
        return [max(0, round(float(t) * 10)) for t in value]
    except (TypeError, ValueError) as err:
        raise ValueError(
            f"timeline should be a list of marker times in seconds, like [3.4, 6.4]; got {value!r}"
        ) from err


def format_like(original: str, tenths: int) -> str:
    """A time of `tenths` written in the same format as `original`, so
    ("00:03.400", 20) -> "00:02.000" and ("6.4", 20) -> "2.0"."""
    whole, decimals = original.split(".")
    seconds, tenth = divmod(tenths, 10)
    fraction = str(tenth) + "0" * (len(decimals) - 1)
    if ":" in whole:
        minute_digits, second_digits = (len(part) for part in whole.split(":"))
        minutes, seconds = divmod(seconds, 60)
        return f"{minutes:0{minute_digits}d}:{seconds:0{second_digits}d}.{fraction}"
    return f"{seconds:0{len(whole)}d}.{fraction}"


def retime(text: str, times: list[int]) -> str:
    """Rewrites the n-th marker in `text` to `times[n]` (tenths of a second)."""
    remaining = iter(times)

    def replace(match: re.Match) -> str:
        tenths = next(remaining, None)
        if tenths is None:
            return match.group(0)
        return match.group(1) + format_like(match.group(2), tenths)

    return MARKER_RE.sub(replace, text)


class ModularTimeline(io.ComfyNode):
    """Rewrites the text's markers to the times set on the timeline."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="CherryModularTimeline",
            display_name="Modular Timeline 🍒",
            category="utils/text",
            description=(
                "Shows the 'at 3.4' / 'at 00:03.400' markers in the text as a "
                "timeline. Drag a marker to retime it, and the marker in the "
                "text is rewritten to match."
            ),
            search_aliases=["timeline", "marker", "timestamp", "retime", "cue", "minimax"],
            inputs=[
                io.String.Input("text", force_input=True, tooltip="Text with 'at <time>' markers."),
                # Drawn by the frontend; the prompt gets the marker times in
                # seconds, in the order the markers appear in the text.
                Timeline.Input(
                    "timeline",
                    optional=True,
                    tooltip=(
                        "Drag a marker to change its time. Shift+drag to box "
                        "several markers, then drag one to move them "
                        "together. Reset reads the markers from the input "
                        "text again."
                    ),
                ),
            ],
            outputs=[
                io.String.Output(display_name="text"),
            ],
        )

    @classmethod
    def execute(cls, text: str, timeline: str = "") -> io.NodeOutput:
        times = parse_timeline(timeline)
        found = len(MARKER_RE.findall(text))
        if times and found != len(times):
            logging.warning(
                "[Modular Timeline] the text has %d markers but the timeline has %d; "
                "press Reset on the node to rebuild it.",
                found,
                len(times),
            )
        # The input goes back to the widget, so it can tell when the text no
        # longer matches the timeline, and has something to Reset from when
        # the text can't be read in the browser.
        return io.NodeOutput(retime(text, times), ui={"timeline_text": [text]})
