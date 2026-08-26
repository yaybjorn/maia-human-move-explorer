import re
from io import StringIO

import chess
import chess.pgn

from .chess_state import PositionError, replay


def parse_pgn_games(pgn_text: str) -> list[chess.pgn.Game]:
    stream = StringIO(pgn_text.strip())
    games: list[chess.pgn.Game] = []
    while True:
        try:
            game = chess.pgn.read_game(stream)
        except (ValueError, IndexError) as exc:
            raise PositionError(_pgn_error_message(exc)) from exc
        if game is None:
            break
        if game.errors:
            raise PositionError(_pgn_error_message(game.errors[0]))
        if game.headers.get("SetUp") == "1" or game.headers.get("FEN"):
            raise PositionError("PGN must begin from the standard starting position")
        games.append(game)
    if not games:
        raise PositionError("Invalid PGN: no game found")
    return games


def writing_sources(pgn_text: str) -> list[dict]:
    """Return every PGN comment with its move history, without running chess engines."""
    sources = []

    def add(comment: str, sans: list[str], board) -> None:
        comment = comment.strip()
        if comment:
            sources.append({
                "history": _history(sans),
                "fen": board.fen(),
                "comment": comment,
            })

    def walk(node: chess.pgn.GameNode, sans: list[str]) -> None:
        board = node.board()
        add(getattr(node, "comment", ""), sans, board)
        for child in node.variations:
            add(getattr(child, "starting_comment", ""), sans, board)
            walk(child, [*sans, board.san(child.move)])

    for game in parse_pgn_games(pgn_text):
        walk(game, [])
    return sources


def check_repertoire(pgn_text: str, repertoire_side: str, rating: int,
                     threshold: float, maia_engine, stockfish_engine=None) -> dict:
    """Find probable opponent replies that are absent from a standard-start PGN tree."""
    if repertoire_side not in {"white", "black"}:
        raise PositionError("Repertoire side must be white or black")

    games = parse_pgn_games(pgn_text)

    opponent = chess.BLACK if repertoire_side == "white" else chess.WHITE
    positions: dict[tuple[str, ...], dict] = {}
    has_comments = any(
        getattr(node, "comment", "") or getattr(node, "starting_comment", "")
        for game in games
        for node in _nodes(game)
    )
    excluded_before_opening = 0

    def walk(node: chess.pgn.GameNode, moves: list[str], sans: list[str],
             opening_started: bool = False) -> None:
        nonlocal excluded_before_opening
        board = node.board()
        node_has_comment = bool(
            getattr(node, "comment", "") or getattr(node, "starting_comment", "")
        )
        opening_started = opening_started or node_has_comment or not has_comments
        is_opponent_position = (
            board.turn == opponent and node.variations and not board.is_game_over()
        )
        if is_opponent_position and not opening_started:
            excluded_before_opening += 1
        if is_opponent_position and opening_started:
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
            walk(
                child,
                [*moves, child.move.uci()],
                [*sans, board.san(child.move)],
                opening_started,
            )

    for game in games:
        walk(game, [], [])

    if len(positions) > 500:
        raise PositionError("PGN contains more than 500 opponent positions; split it into smaller files")

    findings = []
    analyzed = 0
    covered = 0
    distributions = {}
    for key, entry in sorted(positions.items(), key=lambda item: len(item[0])):
        position = replay(chess.STARTING_FEN, entry["moves"])
        scored = maia_engine._predict_all(position, rating, rating)
        distributions[key] = {move["uci"]: move["probability"] for move in scored}
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
            reach = _reach_probability(entry["moves"], distributions)
            missing_mass = sum(move["probability"] for move in missing)
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
                "reach_probability": round(reach, 6),
                "missing_probability_mass": round(missing_mass, 6),
                "priority_score": round(reach * missing_mass, 6),
            })

    minimum_priority = 0.005
    excluded_low_priority = sum(1 for item in findings if item["priority_score"] < minimum_priority)
    findings = [item for item in findings if item["priority_score"] >= minimum_priority]
    excluded_winning = 0
    if stockfish_engine is not None:
        kept = []
        for item in findings:
            analysis = stockfish_engine.analyze(chess.Board(item["fen"]))
            evaluation = analysis["lines"][0]["evaluation"]
            item["evaluation"] = evaluation
            if _already_winning(evaluation, repertoire_side):
                excluded_winning += 1
            else:
                kept.append(item)
        findings = kept

    findings.sort(key=lambda item: (-item["priority_score"], item["ply"]))
    return {
        "positions_analyzed": analyzed,
        "positions_needing_attention": len(findings),
        "missing_moves": sum(len(item["missing"]) for item in findings),
        "covered_moves": covered,
        "excluded_already_winning": excluded_winning,
        "excluded_low_priority": excluded_low_priority,
        "excluded_before_opening": excluded_before_opening,
        "opening_boundary": "first_comment" if has_comments else "full_pgn",
        "minimum_priority": minimum_priority,
        "threshold": threshold,
        "rating": rating,
        "repertoire_side": repertoire_side,
        "findings": findings,
    }


def _reach_probability(moves: list[str], distributions: dict) -> float:
    probability = 1.0
    for index, uci in enumerate(moves):
        distribution = distributions.get(tuple(moves[:index]))
        if distribution is not None:
            probability *= distribution.get(uci, 0.0)
    return probability


def _already_winning(evaluation: dict, repertoire_side: str) -> bool:
    value = evaluation["value"]
    if evaluation["type"] == "mate":
        white_score = 100_000 if value > 0 else -100_000
    else:
        white_score = value
    repertoire_score = white_score if repertoire_side == "white" else -white_score
    return repertoire_score >= 200


def _mentioned(san: str, uci: str, comments: str) -> bool:
    if not comments:
        return False
    tokens = {uci.lower(), san.lower(), san.rstrip("+#").lower()}
    lowered = comments.lower()
    return any(re.search(rf"(?<![a-z0-9]){re.escape(token)}(?![a-z0-9])", lowered)
               for token in tokens)


def _pgn_error_message(error: Exception) -> str:
    detail = str(error)
    illegal_san = re.search(r"illegal san: '([^']+)'", detail, re.IGNORECASE)
    if illegal_san:
        token = illegal_san.group(1)
        return (
            f"Invalid PGN near '{token}'. It appears that prose escaped a {{...}} comment "
            "block, so the parser tried to read it as a move. Check the braces around the "
            "nearby comment and upload the PGN again."
        )
    return f"Invalid PGN: {detail}"


def _history(sans: list[str]) -> str:
    chunks = []
    for index in range(0, len(sans), 2):
        chunk = f"{index // 2 + 1}. {sans[index]}"
        if index + 1 < len(sans):
            chunk += f" {sans[index + 1]}"
        chunks.append(chunk)
    return " ".join(chunks) or "Starting position"


def _nodes(root: chess.pgn.GameNode):
    yield root
    for child in root.variations:
        yield from _nodes(child)
