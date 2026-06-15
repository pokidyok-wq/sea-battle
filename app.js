/* Sea Battle — online 2-player Battleship over Supabase.
 *
 * The whole game state lives in one `games` row as JSONB. Both clients
 * subscribe to Realtime changes on that row and re-render. Minimal-effort
 * design: no accounts, just a room code; trust the client (no anti-cheat).
 */

(() => {
  "use strict";

  const SIZE = 10;
  // Classic fleet: 1×4, 2×3, 3×2, 4×1 — 10 ships, 20 squares total.
  const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
  const TOTAL_SHIP_CELLS = FLEET.reduce((a, b) => a + b, 0);
  const CELL = 33; // px per cell
  const MARGIN = 22; // gutter for A–J / 1–10 labels; canvas = MARGIN + SIZE*CELL
  const LETTERS = "ABCDEFGHIJ";

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
  const ox = (c) => MARGIN + c * CELL;
  const oy = (r) => MARGIN + r * CELL;

  function drawGrid(ctx) {
    const span = SIZE * CELL;
    ctx.clearRect(0, 0, MARGIN + span, MARGIN + span);
    ctx.fillStyle = "#0c2540";
    ctx.fillRect(MARGIN, MARGIN, span, span);
    ctx.strokeStyle = "#20496f";
    ctx.lineWidth = 1;
    for (let i = 0; i <= SIZE; i++) {
      ctx.beginPath();
      ctx.moveTo(MARGIN + i * CELL + 0.5, MARGIN);
      ctx.lineTo(MARGIN + i * CELL + 0.5, MARGIN + span);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(MARGIN, MARGIN + i * CELL + 0.5);
      ctx.lineTo(MARGIN + span, MARGIN + i * CELL + 0.5);
      ctx.stroke();
    }
    // labels: A–J across the top, 1–10 down the left
    ctx.fillStyle = "#9fb6cf";
    ctx.font = "12px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let c = 0; c < SIZE; c++)
      ctx.fillText(LETTERS[c], ox(c) + CELL / 2, MARGIN / 2);
    for (let r = 0; r < SIZE; r++)
      ctx.fillText(String(r + 1), MARGIN / 2, oy(r) + CELL / 2);
  }

  function fillCell(ctx, r, c, color) {
    ctx.fillStyle = color;
    ctx.fillRect(ox(c) + 2, oy(r) + 2, CELL - 3, CELL - 3);
  }

  function drawDot(ctx, r, c, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(ox(c) + CELL / 2, oy(r) + CELL / 2, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawX(ctx, r, c, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    const pad = 8;
    ctx.beginPath();
    ctx.moveTo(ox(c) + pad, oy(r) + pad);
    ctx.lineTo(ox(c) + CELL - pad, oy(r) + CELL - pad);
    ctx.moveTo(ox(c) + CELL - pad, oy(r) + pad);
    ctx.lineTo(ox(c) + pad, oy(r) + CELL - pad);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // A ship is sunk when every one of its cells has been hit (shots === 2).
  function isSunk(ship, shots) {
    return ship.cells.every(([r, c]) => shots[r][c] === 2);
  }

  // Ring the sunk ship with dots on every surrounding water cell.
  function drawSunkOutline(ctx, ship) {
    const occ = new Set(ship.cells.map(([r, c]) => r + "," + c));
    const perim = new Set();
    for (const [r, c] of ship.cells)
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
          const k = nr + "," + nc;
          if (!occ.has(k)) perim.add(k);
        }
    for (const k of perim) {
      const [r, c] = k.split(",").map(Number);
      drawDot(ctx, r, c, "#7fa6cc");
    }
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

  // Render a fleet status panel: one icon per ship, sunk ones shown in red,
  // plus an "afloat / total" tally. `ships` are the ships being tracked and
  // `shots` are the shots fired *at* those ships (2 = hit).
  function renderFleetStatus(el, ships, shots, label) {
    if (!el) return;
    if (!ships || !ships.length) {
      el.innerHTML = "";
      return;
    }
    const sorted = [...ships].sort((a, b) => b.cells.length - a.cells.length);
    let afloat = 0;
    const pills = sorted
      .map((ship) => {
        const sunk = isSunk(ship, shots);
        if (!sunk) afloat++;
        const segs = ship.cells.map(() => '<span class="seg"></span>').join("");
        const len = ship.cells.length;
        return (
          '<span class="fleet-ship' +
          (sunk ? " sunk" : "") +
          '" title="' +
          len +
          "-cell ship" +
          (sunk ? " — sunk" : "") +
          '">' +
          segs +
          "</span>"
        );
      })
      .join("");
    el.innerHTML =
      '<div class="fleet-head"><span>' +
      label +
      '</span><span class="fleet-count">' +
      afloat +
      "/" +
      ships.length +
      " afloat</span></div>" +
      '<div class="fleet-row">' +
      pills +
      "</div>";
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
    // outline any enemy ship we've fully sunk
    const other = role === "host" ? "guest" : "host";
    const enemy = game.boards && game.boards[other];
    if (enemy && enemy.ships)
      for (const ship of enemy.ships)
        if (isSunk(ship, shots)) drawSunkOutline(ctx, ship);
    renderFleetStatus($("enemy-fleet"), enemy && enemy.ships, shots, "Enemy fleet");
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
    // outline any of our ships the opponent has sunk
    if (mine && mine.ships)
      for (const ship of mine.ships)
        if (isSunk(ship, incoming)) drawSunkOutline(ctx, ship);
    renderFleetStatus($("own-fleet"), mine && mine.ships, incoming, "Your fleet");
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
    clearTurnBg();
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
    document.body.classList.toggle("turn-mine", myTurn);
    document.body.classList.toggle("turn-theirs", !myTurn);
    setStatus(myTurn ? "Your turn — fire at enemy waters!" : "Opponent's turn…");
  }

  function clearTurnBg() {
    document.body.classList.remove("turn-mine", "turn-theirs");
  }

  function enterGameOver() {
    show("gameover");
    clearTurnBg();
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
    const x = (e.clientX - rect.left) * (canvas.width / rect.width) - MARGIN;
    const y = (e.clientY - rect.top) * (canvas.height / rect.height) - MARGIN;
    if (x < 0 || y < 0) return null;
    const c = Math.floor(x / CELL);
    const r = Math.floor(y / CELL);
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
