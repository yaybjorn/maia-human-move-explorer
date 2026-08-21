import re
from io import StringIO

import chess
import chess.pgn

from .chess_state import PositionError, replay


def check_repertoire(pgn_text: str, repertoire_side: str, rating: int,
                     threshold: float, maia_engine) -> dict:
    """Find probable opponent replies that are absent from a standard-start PGN tree."""
    if repertoire_side not in {"white", "black"}:
        raise PositionError("Repertoire side must be white or black")

    stream = StringIO(pgn_text.strip())
    games: list[chess.pgn.Game] = []
    while True:
        try:
            game = chess.pgn.read_game(stream)
        except (ValueError, IndexError) as exc:
            raise PositionError(f"Invalid PGN: {exc}") from exc
        if game is None:
            break
        if game.errors:
            raise PositionError(f"Invalid PGN: {game.errors[0]}")
        if game.headers.get("SetUp") == "1" or game.headers.get("FEN"):
            raise PositionError("PGN must begin from the standard starting position")
        games.append(game)
    if not games:
        raise PositionError("Invalid PGN: no game found")

    opponent = chess.BLACK if repertoire_side == "white" else chess.WHITE
    positions: dict[tuple[str, ...], dict] = {}

    def walk(node: chess.pgn.GameNode, moves: list[str], sans: list[str]) -> None:
        board = node.board()
        if board.turn == opponent and node.variations and not board.is_game_over():
            key = tuple(moves)
            entry = positions.setdefault(key, {
                "moves": list(moves),
                "sans": list(sans),
                "board": board,
                "existing": set(),
                "comments": [],
            })
            entry["existing"].update(child.move.uci() for child in node.variations)
            for comment in (getattr(node, "comment", ""), getattr(node, "starting_comment", "")):
                if comment and comment not in entry["comments"]:
                    entry["comments"].append(comment)

        for child in node.variations:
            walk(child, [*moves, child.move.uci()], [*sans, board.san(child.move)])

    for game in games:
        walk(game, [], [])

    if len(positions) > 500:
        raise PositionError("PGN contains more than 500 opponent positions; split it into smaller files")

    findings = []
    analyzed = 0
    covered = 0
    for entry in positions.values():
        position = replay(chess.STARTING_FEN, entry["moves"])
        scored = maia_engine._predict_all(position, rating, rating)
        analyzed += 1
        comments = " ".join(entry["comments"])
        missing = []
        for move in scored:
            if move["probability"] < threshold:
                continue
            if move["uci"] in entry["existing"]:
                covered += 1
                continue
            if _mentioned(move["san"], move["uci"], comments):
                covered += 1
                continue
            missing.append(move)
        if missing:
            board = entry["board"]
            findings.append({
                "ply": len(entry["moves"]),
                "move_number": board.fullmove_number,
                "side_to_move": "white" if board.turn else "black",
                "history": _history(entry["sans"]),
                "fen": board.fen(),
                "existing_replies": [
                    {"uci": uci, "san": board.san(chess.Move.from_uci(uci))}
                    for uci in sorted(entry["existing"])
                ],
                "comments": entry["comments"],
                "missing": missing,
            })

    findings.sort(key=lambda item: (-item["missing"][0]["probability"], item["ply"]))
    return {
        "positions_analyzed": analyzed,
        "positions_needing_attention": len(findings),
        "missing_moves": sum(len(item["missing"]) for item in findings),
        "covered_moves": covered,
        "threshold": threshold,
        "rating": rating,
        "repertoire_side": repertoire_side,
        "findings": findings,
    }


def _mentioned(san: str, uci: str, comments: str) -> bool:
    if not comments:
        return False
    tokens = {uci.lower(), san.lower(), san.rstrip("+#").lower()}
    lowered = comments.lower()
    return any(re.search(rf"(?<![a-z0-9]){re.escape(token)}(?![a-z0-9])", lowered)
               for token in tokens)


def _history(sans: list[str]) -> str:
    chunks = []
    for index in range(0, len(sans), 2):
        chunk = f"{index // 2 + 1}. {sans[index]}"
        if index + 1 < len(sans):
            chunk += f" {sans[index + 1]}"
        chunks.append(chunk)
    return " ".join(chunks) or "Starting position"
