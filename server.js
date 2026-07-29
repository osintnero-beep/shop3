const express = require('express');
const axios = require('axios');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Carica .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
}

console.log('=== VARIABILI .env ===');
console.log('DISCORD_CLIENT_ID:', process.env.DISCORD_CLIENT_ID || '❌ NON TROVATO');
console.log('DISCORD_CLIENT_SECRET:', process.env.DISCORD_CLIENT_SECRET ? '✅ TROVATO' : '❌ NON TROVATO');
console.log('======================');

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIGURAZIONE
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.APP_URL ? 
    `${process.env.APP_URL}/auth/discord/callback` : 
    'http://localhost:3000/auth/discord/callback';
const SESSION_SECRET = process.env.SESSION_SECRET || 'una_chiave_super_sicura';

// Middleware
app.use(cors({
    origin: [process.env.APP_URL || 'http://localhost:3000'],
    credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Sessioni
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24
    }
}));

// ===== FILE PER I DATI =====
const DATA_FILE = path.join(__dirname, 'data.json');

function getData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            return JSON.parse(data);
        }
        return { 
            users: {}, 
            orders: [],
            creditTransactions: []
        };
    } catch (error) {
        console.error('Errore lettura dati:', error);
        return { users: {}, orders: [], creditTransactions: [] };
    }
}

function saveData(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('Errore salvataggio dati:', error);
        return false;
    }
}

// ===== ROTTE AUTENTICAZIONE =====

app.get('/auth/discord', (req, res) => {
    const discordAuthUrl = 'https://discord.com/api/oauth2/authorize';
    const params = new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        redirect_uri: DISCORD_REDIRECT_URI,
        response_type: 'code',
        scope: 'identify email',
        prompt: 'consent'
    });
    res.redirect(`${discordAuthUrl}?${params.toString()}`);
});

app.get('/auth/discord/callback', async (req, res) => {
    const { code } = req.query;

    if (!code) {
        return res.redirect('/?auth=error');
    }

    try {
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token',
            new URLSearchParams({
                client_id: DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: DISCORD_REDIRECT_URI,
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            }
        );

        const { access_token } = tokenResponse.data;

        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: {
                Authorization: `Bearer ${access_token}`,
            },
        });

        const userData = userResponse.data;

        const OWNER_DISCORD_ID = '1490001912232149152';
        
        const data = getData();
        
        if (!data.users[userData.id]) {
            data.users[userData.id] = {
                id: userData.id,
                username: userData.username,
                global_name: userData.global_name || userData.username,
                avatar: userData.avatar,
                email: userData.email,
                credits: 0,
                robloxUsername: null,
                purchasedItems: [], // Per tenere traccia degli acquisti singoli
                joinedAt: new Date().toISOString()
            };
            saveData(data);
        }

        req.session.user = {
            id: userData.id,
            username: userData.username,
            discriminator: userData.discriminator,
            avatar: userData.avatar,
            email: userData.email,
            global_name: userData.global_name || userData.username,
            isOwner: userData.id === OWNER_DISCORD_ID,
            credits: data.users[userData.id]?.credits || 0,
            robloxUsername: data.users[userData.id]?.robloxUsername || null,
            purchasedItems: data.users[userData.id]?.purchasedItems || []
        };

        console.log(`✅ Utente loggato: ${userData.username} (ID: ${userData.id})`);
        console.log(`👑 È owner? ${req.session.user.isOwner ? 'SÌ' : 'NO'}`);

        res.redirect('/?auth=success');

    } catch (error) {
        console.error('Errore autenticazione:', error.response?.data || error.message);
        res.redirect('/?auth=error');
    }
});

// ===== ROTTE API =====

app.get('/api/user', (req, res) => {
    if (req.session.user) {
        res.json({ user: req.session.user });
    } else {
        res.json({ user: null });
    }
});

app.get('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Errore logout' });
        }
        res.json({ success: true });
    });
});

// ===== ROTTE CREDITI =====

app.post('/api/credits/add', (req, res) => {
    if (!req.session.user || !req.session.user.isOwner) {
        return res.status(403).json({ error: 'Accesso negato' });
    }

    const { userId, amount, reason } = req.body;
    
    if (!userId || !amount || amount <= 0) {
        return res.status(400).json({ error: 'Dati mancanti o non validi' });
    }

    const data = getData();
    
    if (!data.users[userId]) {
        return res.status(404).json({ error: 'Utente non trovato' });
    }

    data.users[userId].credits = (data.users[userId].credits || 0) + parseInt(amount);
    
    data.creditTransactions.push({
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        userId: userId,
        username: data.users[userId].username,
        amount: parseInt(amount),
        reason: reason || 'Aggiunta manuale',
        type: 'add',
        ownerId: req.session.user.id,
        createdAt: new Date().toISOString()
    });

    saveData(data);

    if (req.session.user.id === userId) {
        req.session.user.credits = data.users[userId].credits;
    }

    res.json({ 
        success: true, 
        newCredits: data.users[userId].credits,
        user: data.users[userId]
    });
});

app.get('/api/users', (req, res) => {
    if (!req.session.user || !req.session.user.isOwner) {
        return res.status(403).json({ error: 'Accesso negato' });
    }

    const data = getData();
    const users = Object.values(data.users).map(u => ({
        id: u.id,
        username: u.username,
        global_name: u.global_name,
        credits: u.credits || 0,
        robloxUsername: u.robloxUsername || null,
        purchasedItems: u.purchasedItems || [],
        joinedAt: u.joinedAt
    }));

    res.json({ users });
});

// ===== ROTTE ROBLOX =====

app.post('/api/roblox/link', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Non autenticato' });
    }

    const { robloxUsername } = req.body;
    
    if (!robloxUsername || robloxUsername.length < 2) {
        return res.status(400).json({ error: 'Username Roblox non valido' });
    }

    const data = getData();
    data.users[req.session.user.id].robloxUsername = robloxUsername;
    saveData(data);

    req.session.user.robloxUsername = robloxUsername;

    res.json({ success: true, robloxUsername });
});

// ===== ROTTE ORDINI =====

// Controlla se un item è già stato acquistato (singolo)
app.get('/api/check-purchased/:itemName', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Non autenticato' });
    }

    const itemName = req.params.itemName;
    const data = getData();
    const user = data.users[req.session.user.id];
    const isPurchased = user?.purchasedItems?.includes(itemName) || false;

    res.json({ isPurchased });
});

app.post('/api/orders', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Non autenticato' });
    }

    const { passName, price, category, customDetails } = req.body;
    
    if (!passName || !price) {
        return res.status(400).json({ error: 'Dati mancanti' });
    }

    const data = getData();
    const user = data.users[req.session.user.id];
    
    // Verifica se è un acquisto singolo (non riacquistabile)
    const singlePurchaseItems = ['Tec-9', 'Glock 17 Switch', 'Walther PPK', 'Custom Avatar'];
    if (singlePurchaseItems.includes(passName)) {
        if (user?.purchasedItems?.includes(passName)) {
            return res.status(400).json({ 
                error: 'Hai già acquistato questo item! Non puoi ricomprarlo.',
                alreadyPurchased: true
            });
        }
    }

    // Controlla crediti
    const userCredits = user?.credits || 0;
    if (userCredits < parseInt(price)) {
        return res.status(400).json({ error: 'Crediti insufficienti' });
    }

    // Sottrai i crediti
    user.credits = userCredits - parseInt(price);
    
    // Se è un acquisto singolo, salva nella lista
    if (singlePurchaseItems.includes(passName)) {
        if (!user.purchasedItems) user.purchasedItems = [];
        user.purchasedItems.push(passName);
    }
    
    const newOrder = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        userId: req.session.user.id,
        username: req.session.user.username,
        userAvatar: req.session.user.avatar,
        passName: passName,
        price: parseInt(price),
        category: category || 'custom',
        status: 'pending',
        createdAt: new Date().toISOString(),
        completedAt: null,
        robloxUsername: user?.robloxUsername || null,
        // Dettagli personalizzati per Custom Level, Name, Emoji
        customDetails: customDetails || null
    };

    data.orders.push(newOrder);
    saveData(data);

    // Aggiorna la sessione
    req.session.user.credits = user.credits;
    req.session.user.purchasedItems = user.purchasedItems || [];

    res.json({ 
        success: true, 
        order: newOrder, 
        newCredits: req.session.user.credits,
        alreadyPurchased: false
    });
});

app.get('/api/orders/my', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Non autenticato' });
    }

    const data = getData();
    const userOrders = data.orders.filter(o => o.userId === req.session.user.id);
    res.json({ orders: userOrders });
});

app.get('/api/orders/all', (req, res) => {
    if (!req.session.user || !req.session.user.isOwner) {
        return res.status(403).json({ error: 'Accesso negato' });
    }

    const data = getData();
    res.json({ orders: data.orders });
});

app.post('/api/orders/:id/accept', (req, res) => {
    if (!req.session.user || !req.session.user.isOwner) {
        return res.status(403).json({ error: 'Accesso negato' });
    }

    const orderId = req.params.id;
    const data = getData();
    const orderIndex = data.orders.findIndex(o => o.id === orderId);

    if (orderIndex === -1) {
        return res.status(404).json({ error: 'Ordine non trovato' });
    }

    if (data.orders[orderIndex].status === 'completed') {
        return res.status(400).json({ error: 'Ordine già completato' });
    }

    data.orders[orderIndex].status = 'completed';
    data.orders[orderIndex].completedAt = new Date().toISOString();
    saveData(data);

    res.json({ success: true, order: data.orders[orderIndex] });
});

// ===== FRONTEND =====
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== AVVIA SERVER =====
app.listen(PORT, () => {
    console.log(`✅ Server avviato su http://localhost:${PORT}`);
    console.log(`✅ Redirect URI: ${DISCORD_REDIRECT_URI}`);
    console.log(`👑 Owner ID: 1490001912232149152`);
});