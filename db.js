const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Cesta k souboru databáze
const dbPath = path.resolve(__dirname, 'game.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Chyba při otevírání databáze:', err.message);
    } else {
        console.log('✅ Připojeno k SQLite databázi.');
        initializeDatabase();
    }
});

function initializeDatabase() {
    db.serialize(() => {
        // 1. Tabulka pro uživatele
        db.run(`CREATE TABLE IF NOT EXISTS users (
            playerId TEXT PRIMARY KEY,
            username TEXT UNIQUE,
            password TEXT,
            email TEXT UNIQUE,
            verificationToken TEXT,
            isVerified INTEGER DEFAULT 0
        )`);

        // 2. Tabulka pro kategorie
        db.run(`CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE
        )`);

        // 3. Tabulka pro tajenky
        db.run(`CREATE TABLE IF NOT EXISTS phrases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT,
            category_id INTEGER,
            FOREIGN KEY (category_id) REFERENCES categories (id)
        )`);

        //tabulka pro skore
        db.run(`CREATE TABLE IF NOT EXISTS daily_scores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            playerId TEXT NOT NULL,
            username TEXT NOT NULL,
            score INTEGER NOT NULL,
            date TEXT NOT NULL,
            UNIQUE(playerId, date) -- Zajišťuje pouze jeden záznam na hráče denně
        )`);

        // --- INICIALIZACE DAT ---
        // Používáme INSERT OR IGNORE, aby se data při každém startu neduplikovala
        const categories = ['Technologie', 'Sport', 'Příroda', 'Citáty'];
        const categoryStmt = db.prepare("INSERT OR IGNORE INTO categories (name) VALUES (?)");
        categories.forEach(cat => categoryStmt.run(cat));
        categoryStmt.finalize();

        // Vložení tajenek (vše velkým písmem kvůli Unity klávesnici)
        const phraseStmt = db.prepare("INSERT OR IGNORE INTO phrases (text, category_id) VALUES (?, ?)");

        // 1. Technologie
        phraseStmt.run("PROGRAMOVÁNÍ JE ZÁBAVA", 1);
        phraseStmt.run("UMĚLÁ INTELIGENCE MĚNÍ SVĚT", 1);
        phraseStmt.run("OPERAČNÍ SYSTÉM JE ZÁKLAD", 1);
        phraseStmt.run("POČÍTAČOVÁ SÍŤ SPOJUJE LIDI", 1);

        // 2. Sport
        phraseStmt.run("HOROLEZCI LEZOU VÝŠ", 2);
        phraseStmt.run("ZLATÁ MEDAILE Z OLYMPIÁDY", 2);
        phraseStmt.run("FOTBALOVÉ UTKÁNÍ ZAČÍNÁ", 2);
        phraseStmt.run("POCTIVÝ TRÉNINK NESE OVOCE", 2);

        // 3. Příroda
        phraseStmt.run("SNĚŽKA JE NEJVYŠŠÍ HORA", 3);
        phraseStmt.run("LESY JSOU PLÍCE NAŠÍ PLANETY", 3);
        phraseStmt.run("VODOPÁDY HUČÍ V ÚDOLÍ", 3);
        phraseStmt.run("VZÁCNÁ ZVĚŘ ŽIJE V DIVOČINĚ", 3);

        // 4. Citáty (Výroky s interpunkcí)
        phraseStmt.run("KOSTKY JSOU VRŽENY.", 4);
        phraseStmt.run("MYSLÍM, TEDY JSEM.", 4);
        phraseStmt.run("PŘIŠEL JSEM, VIDĚL JSEM, ZVÍTĚZIL JSEM.", 4);

        phraseStmt.finalize();
        console.log('📊 Databáze byla úspěšně zinicializována novým obsahem.');
    });
}

module.exports = db;