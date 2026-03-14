const { users, rooms, players, clientToRoomMap } = require('./state');
const utils = require('./utils');
const db = require('./db'); // PŘIDÁNO: Import databáze

// --- HERNÍ KONSTANTY (AUTORITA) ---
const GUESS_TIME_LIMIT_SECONDS = 10;
const ANIMATION_WAIT_MS = 1500; 
const ALPHABET = "AÁBCČDĎEÉĚFGHIÍJKLLMNŇOÓPQRŘSŠTŤUÚŮVWXYÝZŽ";
const letterValues = {
    'A': 1,'Á': 2,'B': 2,'C': 2,'Č': 4,'D': 1,'Ď': 4,'E': 1,
    'Ě': 4,'É': 6,'F': 3,'G': 3,'H': 2,'I': 1,'Í': 3,'J': 2,'K': 2,'L': 1,'M': 1,
    'N': 1,'Ň': 6,'O': 1,'Ó': 6,'P': 2,'Q': 5,'R': 2,'Ř': 4,'S': 1,'Š': 8,'T': 1,
    'Ť': 4,'U': 1,'Ú': 8,'Ů': 4,'V': 4,'W': 8,'X': 6,'Y': 2,'Ý': 4,'Z': 4,'Ž': 8
};
const MIN_MAX_HEIGHT = { min: 80, max: 200 }; 

function getPhraseFromDB(isDaily = false) {
    return new Promise((resolve, reject) => {
        db.all("SELECT phrases.text, categories.name as category FROM phrases INNER JOIN categories ON phrases.category_id = categories.id", (err, rows) => {
            if (err || !rows || rows.length === 0) {
                reject("Databáze je prázdná");
                return;
            }
            let index;
            if (isDaily) {
                const today = new Date().toISOString().slice(0, 10);
                const seed = parseInt(today.replace(/-/g, ''));
                index = seed % rows.length;
            } else {
                index = Math.floor(Math.random() * rows.length);
            }
            resolve(rows[index]);
        });
    });
}
// --- výběr tajenky a reset místnosti
async function initializeNewPuzzle(roomState, isFullReset) {
    try {
        // POUŽITÍ DB: Čekáme na výsledek
        const quote = await getPhraseFromDB(roomState.isDailyChallenge);

        roomState.currentPhrase = quote.text.toUpperCase();
        roomState.currentCategory = quote.category;
        roomState.remainingLetters = [];
        roomState.guessedLetters = new Set();
        roomState.currentRoundGuesses = new Map(); 
        roomState.isProcessing = false; 
        
        for (const char of roomState.currentPhrase) {
            const upperC = char.toUpperCase();
            if (ALPHABET.includes(upperC)) {
                roomState.remainingLetters.push(upperC);
            }
        }
        
        if (isFullReset) {
            const minHeight = 80; // MIN_MAX_HEIGHT.min
            const maxHeight = 200; // MIN_MAX_HEIGHT.max
            roomState.targetClimbHeight = Math.floor(Math.random() * (maxHeight - minHeight + 1)) + minHeight;
            console.log(`SERVER: Nastavena nová cílová výška: ${roomState.targetClimbHeight}`);
            
            players.forEach(player => {
                if(clientToRoomMap.get(player.id) === roomState.id) {
                    player.score = 0;
                    player.climberPosition = 0;
                }
            });
        }
        return true; // Důležité: async funkce nyní vrací vyřešený slib
    } catch (e) {
        console.error("Chyba v initializeNewPuzzle:", e);
        throw e;
    }
}
// --- Generování písmen pro výběr ---
function generateRandomLetters(roomState) {
    const chosenLetters = [];
    const uniqueRemaining = [...new Set(roomState.remainingLetters)];

    let correctCount = Math.min(2, uniqueRemaining.length);
    let tempRemaining = [...uniqueRemaining];

    while (correctCount > 0 && tempRemaining.length > 0) {
        const index = Math.floor(Math.random() * tempRemaining.length);
        chosenLetters.push(tempRemaining.splice(index, 1)[0]);
        correctCount--;
    }

    while (chosenLetters.length < 10) {
        const randomLetter = ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
        if (!chosenLetters.includes(randomLetter)) {
            chosenLetters.push(randomLetter);
        }
    }
    return chosenLetters.sort(() => Math.random() - 0.5);
}

// --- spuštění časovače kola v místnosti
function startNewRoundTimer(roomID, broadcastToRoom, broadcastGameState) {
    const room = rooms.get(roomID);
    if (!room) return;

    if (room.roundTimer) {
        clearTimeout(room.roundTimer);
    }
    
    room.roundStartTime = Date.now();
    
    room.roundTimer = setTimeout(() => {
        console.log(`⏰ SERVER[${roomID}]: Herní čas vypršel. Zpracovávám výsledky kola.`);
        processRoundResults(roomID, broadcastToRoom, broadcastGameState);
    }, GUESS_TIME_LIMIT_SECONDS * 1000);
}

// --- registrace tahu hráčů
function handlePlayerGuess(data, broadcastToRoom, broadcastGameState) {
    const { playerId, roomID, type, letter } = data;
    const roomState = rooms.get(roomID);
    
    if (!roomState) return;

    if (roomState.currentRoundGuesses.has(playerId)) {
        console.log(`SERVER[${roomID}]: Hráč ${playerId} již odpověděl. Ignoruji duplicitní tah.`);
        return; 
    }

    roomState.currentRoundGuesses.set(playerId, { type, letter });
    
    const allPlayersInRoom = utils.getRoomData(roomID).allPlayersData.length;
    
    if (roomState.currentRoundGuesses.size === allPlayersInRoom) {
        console.log(`SERVER[${roomID}]: Všichni hráči odpověděli. Předčasně zpracovávám výsledky.`);
        if (roomState.roundTimer) clearTimeout(roomState.roundTimer);
        processRoundResults(roomID, broadcastToRoom, broadcastGameState);
    }
}

// --- kontrola správných odpovědí
// gameCore.js - Uprav metodu processRoundResults

function processRoundResults(roomID, broadcastToRoom, broadcastGameState) {
    const roomState = rooms.get(roomID);
    if (!roomState) return;

    if (roomState.isProcessing) return; 
    roomState.isProcessing = true;

    const allResults = []; 
    const allPlayersData = utils.getRoomData(roomID).allPlayersData;

    // --- KLÍČOVÁ ZMĚNA: Kopie zbývajících písmen před vyhodnocením ---
    // Uděláme si Set (množinu) unikátních písmen, která tam SKUTEČNĚ byla na startu kola
    const lettersAvailableThisRound = new Set(roomState.remainingLetters);
    // Budeme si ukládat, která písmena byla v tomto kole úspěšně uhodnuta
    const guessedInThisRound = new Set();

    allPlayersData.forEach(playerData => {
        const playerId = playerData.id;
        const playerState = players.get(playerId); 
        const guessData = roomState.currentRoundGuesses.get(playerId) || { type: 'NO_GUESS', letter: null };
        
        let response = { playerId: playerId, correct: false, pointsGained: 0, moveDistance: 0 };

        if (guessData.type === 'GUESS_LETTER' && guessData.letter) {
            const guessedLetter = guessData.letter.toUpperCase();
            
            // Kontrolujeme proti naší kopii (Setu), ne proti měnícímu se poli
            if (lettersAvailableThisRound.has(guessedLetter)) {
                // SPRÁVNĚ - Písmeno v tajence bylo!
                // Spočítáme body podle původního pole (kolikrát tam písmeno je celkem)
                const count = roomState.remainingLetters.filter(c => c === guessedLetter).length;
                const value = letterValues[guessedLetter] || 1; 
                const points = value * count;

                playerState.score += points;
                playerState.climberPosition += points * 0.5;
                
                response.correct = true;
                response.pointsGained = points;
                response.moveDistance = points;

                // Označíme si, že toto písmeno se má po vyhodnocení kola smazat
                guessedInThisRound.add(guessedLetter);
            } else {
                // ŠPATNĚ
                const penalty = -10;
                playerState.score = Math.max(0, playerState.score + penalty);
                playerState.climberPosition = Math.max(0, playerState.climberPosition - 5.0);
                
                response.pointsGained = penalty;
                response.moveDistance = penalty;
            }
        } else if (guessData.type === 'NO_GUESS') {
            const penalty = -1;
            playerState.score = Math.max(0, playerState.score + penalty);
            playerState.climberPosition = Math.max(0, playerState.climberPosition - 0.5);
            response.pointsGained = penalty;
            response.moveDistance = penalty;
        }

        allResults.push(response);
    });

    // --- FINÁLNÍ ÚKLID: Smažeme všechna uhodnutá písmena z hlavního seznamu ---
    guessedInThisRound.forEach(letter => {
        roomState.remainingLetters = roomState.remainingLetters.filter(c => c !== letter);
        roomState.guessedLetters.add(letter);
    });

    broadcastToRoom(roomID, JSON.stringify({ type: 'ROUND_RESULT', results: allResults }));

    setTimeout(() => {
        roomState.currentRoundGuesses = new Map(); 
        roomState.isProcessing = false; 
        broadcastGameState(roomID);
    }, ANIMATION_WAIT_MS); 
}

module.exports = {
    // Funkce
    initializeNewPuzzle,      
    generateRandomLetters,    
    startNewRoundTimer,      
    handlePlayerGuess,        
    processRoundResults,      
    
    // Konstanty 
    GUESS_TIME_LIMIT_SECONDS, 
    ANIMATION_WAIT_MS,
    ALPHABET,                 
    letterValues,
    MIN_MAX_HEIGHT
};