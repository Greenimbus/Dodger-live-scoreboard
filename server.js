// server.js
const express = require("express");
const fetch = require("node-fetch"); // v2.x
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

const DODGERS_ID = 119; // Dodgers teamId

// Helper: get YYYY-MM-DD
function ymd(d) { return d.toISOString().split("T")[0]; }

app.get("/api/live", async (req, res) => {
  try {
    const today = new Date();
    const startDate = ymd(today);
    const endDate = ymd(new Date(today.getTime() + 6 * 86400000));

    // 1) Find the next Dodgers game (today + next 6 days)
    const scheduleUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${DODGERS_ID}&startDate=${startDate}&endDate=${endDate}`;
    const scheduleResp = await fetch(scheduleUrl);
    const scheduleData = await scheduleResp.json();

    if (!scheduleData || !scheduleData.dates || scheduleData.dates.length === 0) {
      return res.json({ message: "No games scheduled" });
    }

    // pick first date with games; prefer a Dodgers game
    let game = null;
    for (const date of scheduleData.dates) {
      if (date.games && date.games.length) {
        game = date.games.find(g => g.teams?.home?.team?.id === DODGERS_ID || g.teams?.away?.team?.id === DODGERS_ID) || date.games[0];
        if (game) break;
      }
    }
    if (!game) return res.json({ message: "No Dodgers game found in window" });

    const gamePk = game.gamePk;
    const status = game.status?.detailedState || game.status?.abstractGameState || "Scheduled";

    // Upcoming (not started yet)
    if (status.includes("Scheduled") || status.includes("Pre-Game") || status.includes("Warmup")) {
      const opponent = (game.teams.home.team.id === DODGERS_ID) ? game.teams.away.team.name : game.teams.home.team.name;
      return res.json({
        nextGame: { opponent, date: game.gameDate, venue: game.venue?.name || "" }
      });
    }

    // 2) Live/Final: fetch live feed + boxscore
    const liveUrl = `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`;
    const boxUrl  = `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`;

    const [liveResp, boxResp] = await Promise.all([ fetch(liveUrl), fetch(boxUrl) ]);
    const live = await liveResp.json();
    const box  = await boxResp.json();

    const homeTeam = live?.gameData?.teams?.home || {};
    const awayTeam = live?.gameData?.teams?.away || {};
    const abbrHome = homeTeam.abbreviation || "HOME";
    const abbrAway = awayTeam.abbreviation || "AWAY";

    const linescore = live?.liveData?.linescore || {};
    const inningState = linescore?.inningState || "";
    const currentInning = linescore?.currentInning || "";
    const inning = (inningState && currentInning) ? `${inningState} ${currentInning}` : (live?.gameData?.status?.detailedState || "");

    // Confirmed starters (first pitcher listed in boxscore), fallback to probables
    const homePitcherIds = box?.teams?.home?.pitchers || [];
    const awayPitcherIds = box?.teams?.away?.pitchers || [];
    const homeBoxPlayers = box?.teams?.home?.players || {};
    const awayBoxPlayers = box?.teams?.away?.players || {};

    function nameFromBox(players, id) {
      const p = players?.[`ID${id}`];
      return p?.person?.fullName || p?.fullName || null;
    }
    function handFromBox(players, id) {
      const p = players?.[`ID${id}`];
      const hand = p?.pitchHand?.code;
      return hand ? ` (${hand.toUpperCase()})` : "";
    }

    let homeStarterName = homePitcherIds.length ? nameFromBox(homeBoxPlayers, homePitcherIds[0]) : null;
    let awayStarterName = awayPitcherIds.length ? nameFromBox(awayBoxPlayers, awayPitcherIds[0]) : null;
    let homeStarterHand = homePitcherIds.length ? handFromBox(homeBoxPlayers, homePitcherIds[0]) : "";
    let awayStarterHand = awayPitcherIds.length ? handFromBox(awayBoxPlayers, awayPitcherIds[0]) : "";

    const probHome = live?.gameData?.probablePitchers?.home;
    const probAway = live?.gameData?.probablePitchers?.away;
    const probHomeId = probHome?.id || null;
    const probAwayId = probAway?.id || null;

    if (!homeStarterName && probHome) {
      const p = live?.gameData?.players?.[`ID${probHome.id}`];
      homeStarterName = p?.fullName || probHome.fullName || null;
      homeStarterHand = p?.pitchHand?.code ? ` (${p.pitchHand.code})` : "";
    }
    if (!awayStarterName && probAway) {
      const p = live?.gameData?.players?.[`ID${probAway.id}`];
      awayStarterName = p?.fullName || probAway.fullName || null;
      awayStarterHand = p?.pitchHand?.code ? ` (${p.pitchHand.code})` : "";
    }

    const starters = {
      [abbrAway]: awayStarterName ? `${awayStarterName}${awayStarterHand}` : null,
      [abbrHome]: homeStarterName ? `${homeStarterName}${homeStarterHand}` : null
    };

    const homeRuns = linescore?.teams?.home?.runs ?? 0;
    const awayRuns = linescore?.teams?.away?.runs ?? 0;

    // Current pitcher & batter (labels via defense/offense teams)
    const currentPlay = live?.liveData?.plays?.currentPlay || {};
    const balls = currentPlay?.count?.balls ?? 0;
    const strikes = currentPlay?.count?.strikes ?? 0;
    const outs = linescore?.outs ?? currentPlay?.count?.outs ?? 0;

    const defenseTeamId = live?.liveData?.linescore?.defense?.team?.id || null;
    const offenseTeamId = live?.liveData?.linescore?.offense?.team?.id || null;
    const defAbbr = defenseTeamId === homeTeam.id ? abbrHome : (defenseTeamId === awayTeam.id ? abbrAway : "");
    const offAbbr = offenseTeamId === homeTeam.id ? abbrHome : (offenseTeamId === awayTeam.id ? abbrAway : "");

    const curPitcher = currentPlay?.matchup?.pitcher;
    const curBatter  = currentPlay?.matchup?.batter;

    function resolveNameViaPlayers(id) {
      const p = live?.gameData?.players?.[`ID${id}`];
      return p?.fullName || null;
    }
    const pitcherName = curPitcher?.fullName || (curPitcher?.id ? resolveNameViaPlayers(curPitcher.id) : null) || null;
    const batterName  = curBatter?.fullName  || (curBatter?.id  ? resolveNameViaPlayers(curBatter.id)  : null) || null;

    function handFromGameData(id, isPitcher) {
      const p = id ? live?.gameData?.players?.[`ID${id}`] : null;
      const code = isPitcher ? p?.pitchHand?.code : p?.batSide?.code;
      return code ? ` (${code.toUpperCase()})` : "";
    }

    const currentPitcher =
      pitcherName ? `${defAbbr ? defAbbr + ": " : ""}${pitcherName}${handFromGameData(curPitcher?.id, true)}` : null;
    const currentBatter =
      batterName ? `${offAbbr ? offAbbr + ": " : ""}${batterName}${handFromGameData(curBatter?.id, false)} — Count ${balls}-${strikes}, ${outs} out${outs===1?"":"s"}` : null;

    // Runners on base (names)
    function fullNameFromRef(ref) {
      if (!ref) return null;
      const id = ref.id || ref.player?.id || ref.person?.id || null;
      if (!id) return null;
      const p = live?.gameData?.players?.[`ID${id}`];
      return p?.fullName || null;
    }
    const firstName  = fullNameFromRef(live?.liveData?.linescore?.offense?.first);
    const secondName = fullNameFromRef(live?.liveData?.linescore?.offense?.second);
    const thirdName  = fullNameFromRef(live?.liveData?.linescore?.offense?.third);

    const runners = [];
    if (firstName)  runners.push(`1B: ${firstName}`);
    if (secondName) runners.push(`2B: ${secondName}`);
    if (thirdName)  runners.push(`3B: ${thirdName}`);

    // Starter mismatch flag
    const homeStarterId = homePitcherIds.length ? homePitcherIds[0] : null;
    const awayStarterId = awayPitcherIds.length ? awayPitcherIds[0] : null;
    const starterMismatch =
      (homeStarterId && probHomeId && homeStarterId !== probHomeId) ||
      (awayStarterId && probAwayId && awayStarterId !== probAwayId);

    const lastPlay = currentPlay?.result?.description || null;

    return res.json({
      liveGame: {
        away: { team: awayTeam.name, score: awayRuns },
        home: { team: homeTeam.name, score: homeRuns },
        inning,
        starters,
        currentPitcher,
        currentBatter,
        runners: runners.length ? runners : null,
        lastPlay,
        starterMismatch: !!starterMismatch
      }
    });
  } catch (err) {
    console.error("API error:", err);
    return res.status(500).json({ error: "Failed to fetch game data", detail: String(err) });
  }
});

app.get("/", (_req, res) => res.send("Dodgers Live API. Use /api/live"));
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
