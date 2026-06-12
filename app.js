/* Sea Battle — online 2-player Battleship over Supabase.
 *
 * The whole game state lives in one `games` row as JSONB. Both clients
 * subscribe to Realtime changes on that row and re-render. Minimal-effort
 * design: no accounts, just a room code; trust the client (no anti-cheat).
 */

(() => {
  "use strict";

  const SIZE = 10;
  const FLEET = [5, 4, 3, 3, 2]; // carrier, battleship, cruiser, sub, destroyer
  const TOTAL_SHIP_CELLS = FLEET.reduce((a, b) => a + b, 0);
  const CELL = 33; // px, matches 330px canvas (10 cells + nothing extra)

  // ---- Supabase client ----
  const cfg = window.SUPABASE_CONFIG;
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey);

  // ---- Per-browser identity ----
  let myId = localStorage.getItem("seabattle_pid");
  if (!myId) {
    myId = Math.random().toString(36).slice(2, 10);
    localStorage.setItem("seabattle_pid", myId);
  }

  // ---- Local UI state ----
  let roomCode = null;
  let role = null; // "host" | "guest"
  let channel = null;
  let game = null; // last-known server state
  let placement = makeEmptyPlacement(); // { ships:[{cells:[[r,c]]}], board:[[0/1]] }
  let curShipIdx = 0;
  let horizontal = true;
  let hoverCell = null;

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const statusLine = $("status-line");
  const sections = {
    lobby: $("lobby"),
    roomBanner: $("room-banner"),
    placement: $("placement"),
    battle: $("battle"),
    gameover: $("gameover"),
  };

  const placeCanvas = $("place-canvas");
  const enemyCanvas = $("enemy-canvas");
  const ownCanvas = $("own-canvas");

  // ===================================================================
  //  Helpers — state shape
  // ===================================================================
  function makeEmptyPlacement() {
    return {
      ships: [],
      board: Array.from({ length: SIZE }, () => Array(SIZE).fill(0)),
    };
  }

  function emptyShots() {
    // grid of 0=unknown, 1=miss, 2=hit
    return Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  }

  function show(name) {
    Object.entries(sections).forEach(([k, el]) => {
      el.classList.toggle("hidden", k !== name && !(name === "battle" && k === "roomBanner"));
    });
    // roomBanner visibility handled explicitly elsewhere
  }

  function setStatus(msg) {
    statusLine.textContent = msg;
  }

  function randomCode() {
    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O for legibility
    let c = "";
    for (let i = 0; i < 4; i++)
      c += letters[Math.floor(Math.random() * letters.length)];
    return c;
  }

  // ===================================================================
  //  Ship placement
  // ===================================================================
  function canPlace(board, len, r, c, horiz) {
    for (let i = 0; i < len; i++) {
      const rr = horiz ? r : r + i;
      const cc = horiz ? c + i : c;
      if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) return false;
      // no touching (including diagonals)
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const nr = rr + dr;
          const nc = cc + dc;
          if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc])
            return false;
        }
    }
    return true;
  }

  function placeShip(p, len, r, c, horiz) {
    const cells = [];
    for (let i = 0; i < len; i++) {
      const rr = horiz ? r : r + i;
      const cc = horiz ? c + i : c;
      p.board[rr][cc] = 1;
      cells.push([rr, cc]);
    }
    p.ships.push({ cells });
  }

  function randomizePlacement() {
    const p = makeEmptyPlacement();
    for (const len of FLEET) {
      let tries = 0;
      while (tries++ < 1000) {
        const horiz = Math.random() < 0.5;
        const r = Math.floor(Math.random() * SIZE);
        const c = Math.floor(Math.random() * SIZE);
        if (canPlace(p.board, len, r, c, horiz)) {
          placeShip(p, len, r, c, horiz);
          break;
        }
      }
    }
    placement = p;
    curShipIdx = FLEET.length; // all placed
    drawPlacement();
    refreshReadyBtn();
  }

  function resetPlacement() {
    placement = makeEmptyPlacement();
    curShipIdx = 0;
    horizontal = true;
    drawPlacement();
    refreshReadyBtn();
  }

  function refreshReadyBtn() {
    $("btn-ready").disabled = placement.ships.length !== FLEET.length;
  }

  // ===================================================================
  //  Canvas drawing
  // ===================================================================
  function drawGrid(ctx) {
    ctx.clearRect(0, 0, SIZE * CELL, SIZE * CELL);
    ctx.fillStyle = "#0c2540";
    ctx.fillRect(0, 0, SIZE * CELL, SIZE * CELL);
    ctx.strokeStyle = "#20496f";
    ctx.lineWidth = 1;
    for (let i = 0; i <= SIZE; i++) {
      ctx.beginPath();
      ctx.moveTo(i * CELL + 0.5, 0);
      ctx.lineTo(i * CELL + 0.5, SIZE * CELL);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * CELL + 0.5);
      ctx.lineTo(SIZE * CELL, i * CELL + 0.5);
      ctx.stroke();
    }
  }

  function fillCell(ctx, r, c, color) {
    ctx.fillStyle = color;
    ctx.fillRect(c * CELL + 2, r * CELL + 2, CELL - 3, CELL - 3);
  }

  function drawDot(ctx, r, c, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(c * CELL + CELL / 2, r * CELL + CELL / 2, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawX(ctx, r, c, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    const pad = 8;
    ctx.beginPath();
    ctx.moveTo(c * CELL + pad, r * CELL + pad);
    ctx.lineTo((c + 1) * CELL - pad, (r + 1) * CELL - pad);
    ctx.moveTo((c + 1) * CELL - pad, r * CELL + pad);
    ctx.lineTo(c * CELL + pad, (r + 1) * CELL - pad);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  function drawPlacement() {
    const ctx = placeCanvas.getContext("2d");
    drawGrid(ctx);
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++)
        if (placement.board[r][c]) fillCell(ctx, r, c, "#4a6f9c");

    // preview of the ship currently being placed
    if (curShipIdx < FLEET.length && hoverCell) {
      const len = FLEET[curShipIdx];
      const [r, c] = hoverCell;
      const ok = canPlace(placement.board, len, r, c, horizontal);
      for (let i = 0; i < len; i++) {
        const rr = horizontal ? r : r + i;
        const cc = horizontal ? c + i : c;
        if (rr < SIZE && cc < SIZE)
          fillCell(ctx, rr, cc, ok ? "rgba(58,160,255,.55)" : "rgba(255,90,90,.5)");
      }
    }
  }

  // myShots = how *I* see the enemy board (results of my shots)
  function drawEnemy() {
    const ctx = enemyCanvas.getContext("2d");
    drawGrid(ctx);
    const shots = (game.shots && game.shots[role]) || emptyShots();
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++) {
        if (shots[r][c] === 1) drawDot(ctx, r, c, "#cfe0f2");
        else if (shots[r][c] === 2) drawX(ctx, r, c, "#ff5a5a");
      }
  }

  // own board with enemy shots on it
  function drawOwn() {
    const ctx = ownCanvas.getContext("2d");
    drawGrid(ctx);
    const mine = game.boards && game.boards[role];
    if (mine)
      for (let r = 0; r < SIZE; r++)
        for (let c = 0; c < SIZE; c++)
          if (mine.board[r][c]) fillCell(ctx, r, c, "#4a6f9c");

    const other = role === "host" ? "guest" : "host";
    const incoming = (game.shots && game.shots[other]) || emptyShots();
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++) {
        if (incoming[r][c] === 1) drawDot(ctx, r, c, "#cfe0f2");
        else if (incoming[r][c] === 2) drawX(ctx, r, c, "#ff5a5a");
      }
  }

  // ===================================================================
  //  Supabase room sync
  // ===================================================================
  async function createGame() {
    roomCode = randomCode();
    role = "host";
    const initial = {
      status: "placing", // placing -> playing -> finished
      boards: { host: null, guest: null },
      shots: { host: emptyShots(), guest: emptyShots() },
      turn: "host",
      players: { host: myId, guest: null },
      winner: null,
    };
    const { error } = await sb
      .from("games")
      .insert({ code: roomCode, state: initial });
    if (error) {
      setStatus("Could not create game: " + error.message);
      return;
    }
    await subscribe();
    game = initial;
    enterPlacement();
    showRoomBanner();
    setStatus("Waiting for opponent to join with code " + roomCode + "…");
  }

  async function joinGame(code) {
    code = code.toUpperCase().trim();
    if (code.length !== 4) {
      setStatus("Enter a 4-letter room code.");
      return;
    }
    const { data, error } = await sb
      .from("games")
      .select("code,state")
      .eq("code", code)
      .maybeSingle();
    if (error) {
      setStatus("Lookup failed: " + error.message);
      return;
    }
    if (!data) {
      setStatus("No game found with code " + code + ".");
      return;
    }
    const st = data.state;
    if (st.players.guest && st.players.guest !== myId) {
      setStatus("That game is already full.");
      return;
    }
    roomCode = code;
    role = "guest";
    st.players.guest = myId;
    const { error: upErr } = await sb
      .from("games")
      .update({ state: st })
      .eq("code", code);
    if (upErr) {
      setStatus("Join failed: " + upErr.message);
      return;
    }
    await subscribe();
    game = st;
    enterPlacement();
    showRoomBanner();
    setStatus("Joined room " + code + ". Place your fleet!");
  }

  async function subscribe() {
    if (channel) await sb.removeChannel(channel);
    channel = sb
      .channel("game:" + roomCode)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "games",
          filter: "code=eq." + roomCode,
        },
        (payload) => {
          if (payload.new && payload.new.state) {
            game = payload.new.state;
            onState();
          }
        }
      )
      .subscribe();
  }

  // Persist current game state to the row.
  async function pushState() {
    const { error } = await sb
      .from("games")
      .update({ state: game })
      .eq("code", roomCode);
    if (error) setStatus("Sync error: " + error.message);
  }

  // ===================================================================
  //  Game flow reacting to state
  // ===================================================================
  function enterPlacement() {
    show("placement");
    showRoomBanner();
    resetPlacement();
  }

  function showRoomBanner() {
    sections.roomBanner.classList.remove("hidden");
    $("room-code").textContent = roomCode;
  }

  function onState() {
    if (!game) return;
    if (game.status === "placing") {
      // if I already submitted, just wait
      const iAmReady = game.boards[role] != null;
      if (iAmReady) {
        const other = role === "host" ? "guest" : "host";
        if (game.boards[other])
          setStatus("Both ready — starting…");
        else setStatus("Waiting for opponent to place their fleet…");
      }
      // host promotes to playing once both boards present
      if (
        role === "host" &&
        game.boards.host &&
        game.boards.guest &&
        game.status === "placing"
      ) {
        game.status = "playing";
        game.turn = "host";
        pushState();
      }
    } else if (game.status === "playing") {
      enterBattle();
    } else if (game.status === "finished") {
      enterGameOver();
    }
  }

  function enterBattle() {
    show("battle");
    showRoomBanner();
    drawEnemy();
    drawOwn();
    const myTurn = game.turn === role;
    setStatus(myTurn ? "Your turn — fire at enemy waters!" : "Opponent's turn…");
  }

  function enterGameOver() {
    show("gameover");
    sections.roomBanner.classList.add("hidden");
    const iWon = game.winner === role;
    $("gameover-text").textContent = iWon
      ? "🎉 Victory! You sank the enemy fleet."
      : "💥 Defeated. Your fleet is gone.";
    setStatus("");
  }

  async function submitFleet() {
    if (placement.ships.length !== FLEET.length) return;
    game.boards[role] = {
      board: placement.board,
      ships: placement.ships,
    };
    show("placement");
    setStatus("Fleet submitted. Waiting for opponent…");
    await pushState();
    onState();
  }

  // Fire at enemy cell (r,c)
  async function fire(r, c) {
    if (game.status !== "playing") return;
    if (game.turn !== role) return;
    const myShots = game.shots[role];
    if (myShots[r][c] !== 0) return; // already shot here

    const other = role === "host" ? "guest" : "host";
    const enemyBoard = game.boards[other].board;
    const hit = enemyBoard[r][c] === 1;
    myShots[r][c] = hit ? 2 : 1;

    // win check: all enemy ship cells hit?
    let hits = 0;
    for (let rr = 0; rr < SIZE; rr++)
      for (let cc = 0; cc < SIZE; cc++)
        if (myShots[rr][cc] === 2) hits++;
    if (hits >= TOTAL_SHIP_CELLS) {
      game.status = "finished";
      game.winner = role;
    } else if (!hit) {
      game.turn = other; // miss → pass turn; hit → shoot again
    }

    drawEnemy();
    drawOwn();
    setStatus(
      game.status === "finished"
        ? "You win!"
        : hit
        ? "Hit! Fire again."
        : "Miss — opponent's turn."
    );
    await pushState();
  }

  // ===================================================================
  //  Input — canvas → cell
  // ===================================================================
  function cellFromEvent(canvas, e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const c = Math.floor((x / rect.width) * SIZE);
    const r = Math.floor((y / rect.height) * SIZE);
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return null;
    return [r, c];
  }

  placeCanvas.addEventListener("mousemove", (e) => {
    hoverCell = cellFromEvent(placeCanvas, e);
    drawPlacement();
  });
  placeCanvas.addEventListener("mouseleave", () => {
    hoverCell = null;
    drawPlacement();
  });
  placeCanvas.addEventListener("click", (e) => {
    if (curShipIdx >= FLEET.length) return;
    const cell = cellFromEvent(placeCanvas, e);
    if (!cell) return;
    const len = FLEET[curShipIdx];
    const [r, c] = cell;
    if (canPlace(placement.board, len, r, c, horizontal)) {
      placeShip(placement, len, r, c, horizontal);
      curShipIdx++;
      drawPlacement();
      refreshReadyBtn();
      if (curShipIdx < FLEET.length)
        setStatus("Place your " + FLEET[curShipIdx] + "-cell ship.");
      else setStatus("All ships placed — click Ready.");
    }
  });

  enemyCanvas.addEventListener("click", (e) => {
    const cell = cellFromEvent(enemyCanvas, e);
    if (cell) fire(cell[0], cell[1]);
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "r" || e.key === "R") {
      horizontal = !horizontal;
      drawPlacement();
    }
  });

  // ===================================================================
  //  Button wiring
  // ===================================================================
  $("btn-new").addEventListener("click", createGame);
  $("btn-join").addEventListener("click", () => joinGame($("join-code").value));
  $("join-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinGame($("join-code").value);
  });
  $("btn-randomize").addEventListener("click", randomizePlacement);
  $("btn-ready").addEventListener("click", submitFleet);
  $("btn-rotate").addEventListener("click", () => {
    horizontal = !horizontal;
    drawPlacement();
  });
  $("btn-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(roomCode);
      setStatus("Room code copied.");
    } catch {
      setStatus("Copy failed — share the code manually: " + roomCode);
    }
  });
  $("btn-again").addEventListener("click", () => location.reload());

  // ===================================================================
  //  Boot
  // ===================================================================
  function init() {
    if (!cfg || !cfg.url || !cfg.anonKey) {
      setStatus("Missing Supabase config (config.js).");
      return;
    }
    show("lobby");
    setStatus("Start a new game or join with a code.");
  }

  init();
})();
