from dataclasses import dataclass
from io import StringIO

import chess
import chess.pgn


class PositionError(ValueError):
    pass


@dataclass
class ReplayedPosition:
    board: chess.Board
    boards: list[chess.Board]
    sans: list[str]

    @property
    def pgn(self) -> str:
        game = chess.pgn.Game.from_board(self.board)
        exporter = chess.pgn.StringExporter(headers=False, variations=False, comments=False)
        return game.accept(exporter).strip()


def validate_fen(fen: str) -> chess.Board:
    try:
        board = chess.Board(fen.strip())
    except (ValueError, IndexError) as exc:
        raise PositionError(f"Invalid FEN: {exc}") from exc
    if not board.is_valid():
        raise PositionError("Invalid FEN: the position is not a valid chess position")
    return board


def replay(initial_fen: str, moves: list[str]) -> ReplayedPosition:
    board = validate_fen(initial_fen)
    boards = [board.copy(stack=False)]
    sans: list[str] = []
    for index, uci in enumerate(moves):
        try:
            move = chess.Move.from_uci(uci)
        except ValueError as exc:
            raise PositionError(f"Move {index + 1} is not valid UCI") from exc
        if move not in board.legal_moves:
            raise PositionError(f"Move {index + 1} ({uci}) is illegal")
        sans.append(board.san(move))
        board.push(move)
        boards.append(board.copy(stack=False))
    return ReplayedPosition(board, boards, sans)


def legal_moves(board: chess.Board) -> list[dict[str, str]]:
    return [
        {"uci": move.uci(), "from": chess.square_name(move.from_square),
         "to": chess.square_name(move.to_square), "san": board.san(move)}
        for move in board.legal_moves
    ]


def parse_pgn_tree(pgn_text: str) -> tuple[list[dict], dict[str, str]]:
    try:
        game = chess.pgn.read_game(StringIO(pgn_text.strip()))
    except (ValueError, IndexError) as exc:
        raise PositionError(f"Invalid PGN: {exc}") from exc
    if game is None:
        raise PositionError("Invalid PGN: no game found")
    if game.errors:
        raise PositionError(f"Invalid PGN: {game.errors[0]}")
    if game.headers.get("SetUp") == "1" or game.headers.get("FEN"):
        raise PositionError("PGN must begin from the standard starting position so Maia has full history")

    nodes: list[dict] = []
    next_id = 1

    def visit(parent: chess.pgn.GameNode, parent_id: int | None) -> None:
        nonlocal next_id
        board = parent.board()
        for variation in parent.variations:
            node_id = next_id
            next_id += 1
            nodes.append({
                "id": node_id,
                "parent_id": parent_id,
                "uci": variation.move.uci(),
                "san": board.san(variation.move),
                "ply": variation.ply(),
                "comment": variation.comment,
                "starting_comment": variation.starting_comment,
                "nags": sorted(variation.nags),
            })
            visit(variation, node_id)

    visit(game, None)
    if not nodes:
        raise PositionError("Invalid PGN: the game contains no moves")
    headers = {key: value for key, value in game.headers.items() if value not in ("?", "*")}
    return nodes, headers


def export_pgn_tree(nodes: list[dict], headers: dict[str, str] | None = None) -> str:
    game = chess.pgn.Game()
    for key, value in (headers or {}).items():
        if key not in ("FEN", "SetUp"):
            game.headers[key] = value

    created: dict[int, chess.pgn.GameNode] = {}
    for item in nodes:
        parent_id = item.get("parent_id")
        parent = game if parent_id is None else created.get(parent_id)
        if parent is None:
            raise PositionError("Invalid variation tree: parent move is missing")
        try:
            move = chess.Move.from_uci(item["uci"])
        except (KeyError, ValueError) as exc:
            raise PositionError("Invalid variation tree: bad move") from exc
        if move not in parent.board().legal_moves:
            raise PositionError(f"Invalid variation tree: {item.get('uci')} is illegal")
        created[item["id"]] = parent.add_variation(move)
        created[item["id"]].comment = str(item.get("comment") or "").strip()
        created[item["id"]].starting_comment = str(item.get("starting_comment") or "").strip()
        created[item["id"]].nags = {int(nag) for nag in item.get("nags", [])}

    exporter = chess.pgn.StringExporter(headers=True, variations=True, comments=True)
    return game.accept(exporter).strip()
