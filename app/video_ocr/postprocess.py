# Vendored evaluated postprocessor; preserve upstream logic and postponed type-only annotation.
# ruff: noqa: F821, SIM102
from __future__ import annotations

import math
from dataclasses import dataclass, field

# Local evaluation: omit type-only ultralytics import; postponed annotations remain.

CHESSBOARD_CLASS_ID = 0
PIECE_CLASS_IDS = set(range(1, 13))
BLACK_PIECE_CLASS_IDS = {1, 2, 3, 4, 5, 6}
WHITE_PIECE_CLASS_IDS = {7, 8, 9, 10, 11, 12}
RANK_ONE_ID_CLASS_ID = 13
LAST_MOVE_START_CLASS_ID = 14
LAST_MOVE_END_CLASS_ID = 15

PIECE_TO_FEN: dict[str, str] = {
    "black_pawn": "p", "black_rook": "r", "black_bishop": "b",
    "black_knight": "n", "black_king": "k", "black_queen": "q",
    "white_pawn": "P", "white_rook": "R", "white_bishop": "B",
    "white_knight": "N", "white_king": "K", "white_queen": "Q",
}

# Canonical class-id -> name mapping (matches the dataset.yaml). Used by backends
# such as RF-DETR that return raw class ids without an attached name table.
CLASS_NAMES: dict[int, str] = {
    0: "chessboard",
    1: "black_pawn", 2: "black_rook", 3: "black_bishop",
    4: "black_knight", 5: "black_king", 6: "black_queen",
    7: "white_pawn", 8: "white_rook", 9: "white_bishop",
    10: "white_knight", 11: "white_king", 12: "white_queen",
    13: "rank_one_id", 14: "last_move_start_tile", 15: "last_move_end_tile",
}


@dataclass
class Chess2DOCRDetection:
    """Structured result for one detected chessboard: FEN, orientation, and turn."""

    board_xyxy: list[float]
    fen: str
    board_conf: float
    piece_confs: dict[str, float] = field(default_factory=dict)
    orientation: str = "unknown"
    orientation_conf: float = 0.0
    turn: str = "w"
    turn_conf: float = 0.5


def _center(xyxy: list[float]) -> tuple[float, float]:
    return (xyxy[0] + xyxy[2]) / 2.0, (xyxy[1] + xyxy[3]) / 2.0


def _inside(cx: float, cy: float, xyxy: list[float]) -> bool:
    return xyxy[0] <= cx <= xyxy[2] and xyxy[1] <= cy <= xyxy[3]


def _corner_dist(cx: float, cy: float, board_xyxy: list[float]) -> float:
    x1, y1, x2, y2 = board_xyxy
    corners = [(x1, y1), (x2, y1), (x1, y2), (x2, y2)]
    return min(math.hypot(cx - px, cy - py) for px, py in corners)


def _grid_cell(cx: float, cy: float, board_xyxy: list[float]) -> tuple[int, int]:
    """Return (visual_row, visual_col) in [0,7]x[0,7]."""
    x1, y1, x2, y2 = board_xyxy
    col = int((cx - x1) / ((x2 - x1) / 8.0))
    row = int((cy - y1) / ((y2 - y1) / 8.0))
    return max(0, min(7, row)), max(0, min(7, col))


def _build_fen_placement(
    grid: list[list[tuple[str, float] | None]],
    flipped: bool,
) -> tuple[str, dict[str, float]]:
    """Build FEN piece-placement string from the visual 8x8 grid."""
    ranks: list[str] = []
    piece_confs: dict[str, float] = {}

    if not flipped:
        row_order = range(8)
        col_order = range(8)
        def to_algebraic(row: int, col: int) -> str:
            return chr(ord("a") + col) + str(8 - row)
    else:
        row_order = range(7, -1, -1)
        col_order = range(7, -1, -1)
        def to_algebraic(row: int, col: int) -> str:
            return chr(ord("h") - col) + str(row + 1)

    for row in row_order:
        rank_str = ""
        empty = 0
        for col in col_order:
            cell = grid[row][col]
            if cell is None:
                empty += 1
            else:
                class_name, conf = cell
                if empty:
                    rank_str += str(empty)
                    empty = 0
                rank_str += PIECE_TO_FEN[class_name]
                piece_confs[to_algebraic(row, col)] = conf
        if empty:
            rank_str += str(empty)
        ranks.append(rank_str)

    return "/".join(ranks), piece_confs


def process_results(results: Results) -> tuple[list[Chess2DOCRDetection], list[dict]]:
    """Convert raw YOLO Results into structured chess detections.

    Returns (detections, unmatched_pieces).
    """
    if results.boxes is None or len(results.boxes) == 0:
        return [], []

    boxes = [
        {
            "class_id": int(box.cls.item()),
            "conf": float(box.conf.item()),
            "xyxy": box.xyxy.squeeze().tolist(),
        }
        for box in results.boxes
    ]
    return process_detections(boxes, results.names)


def process_detections(
    boxes: list[dict],
    names: dict[int, str],
) -> tuple[list[Chess2DOCRDetection], list[dict]]:
    """Convert backend-agnostic detections into structured chess detections.

    Each box is a dict with ``class_id`` (int), ``conf`` (float), and
    ``xyxy`` (``[x1, y1, x2, y2]`` in pixels). ``names`` maps class id to name.

    Returns (detections, unmatched_pieces).
    """
    if not boxes:
        return [], []

    # parse all boxes into typed lists
    boards: list[dict] = []
    pieces: list[dict] = []
    rank_one_ids: list[dict] = []
    lm_starts: list[dict] = []
    lm_ends: list[dict] = []

    for box in boxes:
        cls_id = box["class_id"]
        conf = box["conf"]
        xyxy = box["xyxy"]
        cx, cy = _center(xyxy)
        entry = {"xyxy": xyxy, "conf": conf, "class_id": cls_id,
                 "class_name": names[cls_id], "cx": cx, "cy": cy}

        if cls_id == CHESSBOARD_CLASS_ID:
            boards.append(entry)
        elif cls_id in PIECE_CLASS_IDS:
            pieces.append(entry)
        elif cls_id == RANK_ONE_ID_CLASS_ID:
            rank_one_ids.append(entry)
        elif cls_id == LAST_MOVE_START_CLASS_ID:
            lm_starts.append(entry)
        elif cls_id == LAST_MOVE_END_CLASS_ID:
            lm_ends.append(entry)

    n = len(boards)
    if n == 0:
        return [], pieces

    # assign pieces to boards
    grids: list[list[list[tuple[str, float] | None]]] = [
        [[None] * 8 for _ in range(8)] for _ in range(n)
    ]
    unmatched_pieces: list[dict] = []

    for piece in pieces:
        matched = False
        for bi, board in enumerate(boards):
            if _inside(piece["cx"], piece["cy"], board["xyxy"]):
                row, col = _grid_cell(piece["cx"], piece["cy"], board["xyxy"])
                current = grids[bi][row][col]
                if current is None or piece["conf"] > current[1]:
                    grids[bi][row][col] = (piece["class_name"], piece["conf"])
                matched = True
                break
        if not matched:
            unmatched_pieces.append({
                "class_name": piece["class_name"],
                "conf": piece["conf"],
                "box_xyxy": piece["xyxy"],
            })

    # assign rank_one_ids to boards (closest corner)
    board_rank1: list[dict | None] = [None] * n
    for r1 in rank_one_ids:
        best_bi = min(range(n), key=lambda i: _corner_dist(r1["cx"], r1["cy"], boards[i]["xyxy"]))
        if board_rank1[best_bi] is None or r1["conf"] > board_rank1[best_bi]["conf"]:
            board_rank1[best_bi] = r1

    # assign last-move tiles to boards
    board_lm_start: list[dict | None] = [None] * n
    board_lm_end: list[dict | None] = [None] * n
    for lm, store in ((lm_starts, board_lm_start), (lm_ends, board_lm_end)):
        for tile in lm:
            for bi, board in enumerate(boards):
                if _inside(tile["cx"], tile["cy"], board["xyxy"]):
                    if store[bi] is None or tile["conf"] > store[bi]["conf"]:
                        store[bi] = tile
                    break

    # build one detection per board
    detections: list[Chess2DOCRDetection] = []
    for bi, board in enumerate(boards):
        # orientation
        r1 = board_rank1[bi]
        if r1 is not None:
            board_cy = (board["xyxy"][1] + board["xyxy"][3]) / 2.0
            flipped = r1["cy"] < board_cy
            orientation = "flipped" if flipped else "normal"
            orientation_conf = r1["conf"]
        else:
            flipped = False
            orientation = "unknown"
            orientation_conf = 0.0

        # turn: the piece on the end tile just moved, so it's the other side's turn
        lm_end = board_lm_end[bi]
        lm_start = board_lm_start[bi]
        turn = "w"
        turn_conf = 0.5

        if lm_end is not None:
            best_piece: dict | None = None
            for piece in pieces:
                if _inside(piece["cx"], piece["cy"], lm_end["xyxy"]):
                    if best_piece is None or piece["conf"] > best_piece["conf"]:
                        best_piece = piece
            if best_piece is not None:
                turn = "w" if best_piece["class_id"] in BLACK_PIECE_CLASS_IDS else "b"
                confs = [lm_end["conf"]]
                if lm_start is not None:
                    confs.append(lm_start["conf"])
                turn_conf = sum(confs) / len(confs)

        fen_placement, piece_confs = _build_fen_placement(grids[bi], flipped)
        detections.append(Chess2DOCRDetection(
            board_xyxy=board["xyxy"], fen=fen_placement, board_conf=board["conf"],
            piece_confs=piece_confs, orientation=orientation,
            orientation_conf=orientation_conf, turn=turn, turn_conf=turn_conf,
        ))

    return detections, unmatched_pieces
