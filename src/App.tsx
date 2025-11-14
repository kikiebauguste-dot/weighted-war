import React, { useEffect, useMemo, useState } from "react";
import { db } from "./firebase";
import {
  collection, doc, setDoc, getDoc, onSnapshot, updateDoc, serverTimestamp
} from "firebase/firestore";

import { auth } from "./firebase";
import { onAuthStateChanged } from "firebase/auth";

type Seat = "A" | "B";
type RoomState = {
  players: Record<string, { name: string; seat: Seat }>;
  hands: Record<Seat, number[]>;
  tableDeck: number[];
  tableIndex: number;
  currentCard: number | null;
  bids: Record<Seat, number | null>;
  pot: number[];
  won: Record<Seat, number[]>;
  phase: "waiting" | "playing" | "finished";
};

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function initDeck(): number[] {
  const base = Array.from({ length: 11 }, (_, i) => i + 1);
  const removedIndex = Math.floor(Math.random() * base.length);
  const removed = base.splice(removedIndex, 1)[0];
  return shuffle(base);
}

async function createRoom(roomId: string, playerId: string, name: string) {
  const tableDeck = initDeck();
  const hands = { A: Array.from({ length: 11 }, (_, i) => i + 1), B: Array.from({ length: 11 }, (_, i) => i + 1) };
  const state: RoomState = {
    players: { [playerId]: { name, seat: "A" } },
    hands,
    tableDeck,
    tableIndex: 0,
    currentCard: null,
    bids: { A: null, B: null },
    pot: [],
    won: { A: [], B: [] },
    phase: "waiting"
  };
  await setDoc(doc(collection(db, "rooms"), roomId), {
    state,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

async function joinRoom(roomId: string, playerId: string, name: string) {
  const ref = doc(collection(db, "rooms"), roomId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Room not found");
  const state = snap.data().state as RoomState;

  if (state.players[playerId]) throw new Error("Already joined");

  const takenSeats = new Set(Object.values(state.players).map(p => p.seat));
  if (takenSeats.has("A") && takenSeats.has("B")) throw new Error("Room full");

  const seat: Seat = takenSeats.has("A") ? "B" : "A";
  state.players[playerId] = { name, seat };

  if (Object.values(state.players).length === 2 && state.phase === "waiting") {
    state.phase = "playing";
    state.currentCard = state.tableDeck[state.tableIndex] ?? null;
  }
  await updateDoc(ref, { state, updatedAt: serverTimestamp() });
}



async function placeBid(roomId: string, playerId: string, seat: Seat, value: number) {
  const ref = doc(collection(db, "rooms"), roomId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data() as any;
  const state = data.state as RoomState;

  if (state.phase !== "playing") return;
  if (state.currentCard == null) return;
  if (!state.players[playerId] || state.players[playerId].seat !== seat) return;

  // Ensure the card exists in hand
  const idx = state.hands[seat].indexOf(value);
  if (idx === -1) return;

  // Place bid
  state.bids[seat] = value;
  // Remove from hand
  state.hands[seat].splice(idx, 1);

  // If both bids are in, resolve
  if (state.bids.A != null && state.bids.B != null) {
    const a = state.bids.A!;
    const b = state.bids.B!;
    const tableCard = state.currentCard!;
    if (a === b) {
      // War: add current card to pot and move to next table card without awarding
      state.pot.push(tableCard);
      state.tableIndex += 1;
      state.currentCard = state.tableDeck[state.tableIndex] ?? null;
      state.bids = { A: null, B: null };
      // If deck exhausted during war, pot is discarded (no one wins it)
      if (state.currentCard == null) {
        // End game
        state.phase = "finished";
      }
    } else {
      const winner: Seat = a > b ? "A" : "B";
      // Winner takes current card plus any pot
      state.won[winner].push(tableCard, ...state.pot);
      state.pot = [];
      // Advance deck
      state.tableIndex += 1;
      state.currentCard = state.tableDeck[state.tableIndex] ?? null;
      state.bids = { A: null, B: null };
      if (state.currentCard == null) {
        state.phase = "finished";
      }
    }
  }

  await updateDoc(ref, { state, updatedAt: serverTimestamp() });
}

function score(cards: number[]) {
  return cards.reduce((s, c) => s + c, 0);
}

export default function App() {

  const [playerId, setPlayerId] = useState<string>(() => {
  // Generate a new ID if none exists in this session
  const existing = sessionStorage.getItem("playerId");
  if (existing) return existing;
  const id = crypto.randomUUID();
  sessionStorage.setItem("playerId", id);
  return id;
});


  const [roomId, setRoomId] = useState(() => {
    const url = new URL(window.location.href);
    return url.searchParams.get("room") || "";
  });

  const [name, setName] = useState(() => sessionStorage.getItem("name") || "");
  const [error, setError] = useState("");
  const [state, setState] = useState<RoomState | null>(null);
  const [seat, setSeat] = useState<Seat | null>(null);

useEffect(() => {
  if (!roomId) return;
  const ref = doc(collection(db, "rooms"), roomId);
  return onSnapshot(ref, (snap) => {
    if (!snap.exists()) return;
    const s = snap.data().state as RoomState;
    setState(s);
    // ❌ Don’t auto‑set seat here
    // const me = s.players[playerId];
    // setSeat(me?.seat ?? null);
  });
}, [roomId]);



  function onCreate() {
    const id = Math.random().toString(36).slice(2, 8);
    setRoomId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("room", id);
    history.replaceState(null, "", url.toString());
    createRoom(id, playerId, name || "Player").catch(e => setError(e.message));
  }

  function onJoin() {
    if (!roomId) { setError("Enter room id or use a share URL."); return; }
    const url = new URL(window.location.href);
    url.searchParams.set("room", roomId);
    history.replaceState(null, "", url.toString());
    joinRoom(roomId, playerId, name || "Player").catch(e => setError(e.message));
  }

  function onBid(value: number) {
    if (!state || !seat || state.phase !== "playing") return;
    if (state.bids[seat] != null) return;
    placeBid(roomId, playerId, seat, value).catch(e => setError(e.message));
  }

  const myHand = useMemo(() => (seat && state ? state.hands[seat] : []), [seat, state]);
  const opponentSeat: Seat | null = seat === "A" ? "B" : seat === "B" ? "A" : null;
  const myBid = seat && state ? state.bids[seat] : null;
  const oppBid = opponentSeat && state ? state.bids[opponentSeat] : null;

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: 16, fontFamily: "system-ui" }}>
      <h1>Weighted War</h1>
      {!state && (
        <div style={{ display: "grid", gap: 8 }}>
          <label>
            Your name:
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); localStorage.setItem("name", e.target.value); }}
              placeholder="Your name"
            />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onCreate}>Create room</button>
            <input
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              placeholder="Room id (or use share URL)"
            />
            <button onClick={onJoin}>Join room</button>
          </div>
          {error && <div style={{ color: "crimson" }}>{error}</div>}
        </div>
      )}

      {state && (
        <>
          <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between" }}>
            <div>
              <strong>Room:</strong> {roomId}{" "}
              <button onClick={() => navigator.clipboard.writeText(window.location.href)}>Copy share link</button>
            </div>
            <div>
              <strong>Phase:</strong> {state.phase}
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <strong>Players:</strong>{" "}
            {Object.values(state.players).map(p => `${p.name}(${p.seat})`).join(" vs ")}
          </div>

          {state.phase === "playing" && (
            <div style={{ marginTop: 16, padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
              <h2>Current table card</h2>
              <div style={{ fontSize: 28, fontWeight: 600 }}>
                {state.currentCard ?? "None"}
              </div>
              <div style={{ marginTop: 8 }}>
                <strong>Pot size:</strong> {state.pot.length} {state.pot.length ? `(${state.pot.reduce((a,b)=>a+b,0)} pts)` : ""}
              </div>

              <div style={{ marginTop: 12, display: "flex", gap: 24 }}>
                <div>
                  <h3>Your bid</h3>
                  <div>{myBid == null ? "Not placed" : myBid}</div>
                </div>
                <div>
                  <h3>Opponent bid</h3>
                  <div>{oppBid == null ? "Not placed" : oppBid}</div>
                </div>
              </div>

              <h3 style={{ marginTop: 16 }}>Your hand</h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {myHand.map(v => (
                  <button
                    key={v}
                    onClick={() => onBid(v)}
                    disabled={myBid != null}
                    style={{ padding: "8px 12px" }}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
              <h3>Your won cards</h3>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(seat ? state.won[seat] : []).map((c, i) => (
                  <span key={i} style={{ padding: "4px 8px", border: "1px solid #ccc", borderRadius: 4 }}>{c}</span>
                ))}
              </div>
              <div style={{ marginTop: 8 }}>
                <strong>Your score:</strong> {seat ? score(state.won[seat]) : 0}
              </div>
            </div>
            <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
              <h3>Opponent won cards</h3>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(opponentSeat ? state.won[opponentSeat] : []).map((c, i) => (
                  <span key={i} style={{ padding: "4px 8px", border: "1px solid #ccc", borderRadius: 4 }}>{c}</span>
                ))}
              </div>
              <div style={{ marginTop: 8 }}>
                <strong>Opponent score:</strong> {opponentSeat ? score(state.won[opponentSeat]) : 0}
              </div>
            </div>
          </div>

          {state.phase === "finished" && (
            <div style={{ marginTop: 16, padding: 12, border: "1px solid #ddd", borderRadius: 8, background: "#f9f9f9" }}>
              <h2>Game over</h2>
              <div><strong>Your score:</strong> {seat ? score(state.won[seat]) : 0}</div>
              <div><strong>Opponent score:</strong> {opponentSeat ? score(state.won[opponentSeat]) : 0}</div>
              <div style={{ marginTop: 8, fontWeight: 600 }}>
                {seat && opponentSeat
                  ? score(state.won[seat]) > score(state.won[opponentSeat]) ? "You win!" :
                    score(state.won[seat]) < score(state.won[opponentSeat]) ? "You lose." : "It's a tie."
                  : ""}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
