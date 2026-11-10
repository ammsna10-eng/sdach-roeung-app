# 🎬 Phsar Roeung - Telegram Mini App & Admin Panel Clone

គម្រោង Clone វេបសាយ និង Telegram Mini App សម្រាប់លក់ និងចាក់បញ្ចាំងភាពយន្ត/រឿងភាគ (Vue 3 + Node.js + Express + Telegram WebApp SDK)។

---

## 🚀 របៀបដំណើរការគម្រោង (How to Run)

### ១. ចាប់ផ្តើម Server (Start Server)
បើក Terminal (PowerShell / Command Prompt) នៅក្នុង Folder នេះ រួចវាយបញ្ជា៖

```bash
npm start
```
ឬ
```bash
node server.js
```

### ២. ចូលមើលតាមរយៈ Browser
* 📱 **ទំព័រ Mini App (ទស្សនារឿង):** [http://localhost:3000/](http://localhost:3000/)
* ⚙️ **ផ្ទាំងគ្រប់គ្រង Admin (Admin Dashboard):** [http://localhost:3000/admin/login](http://localhost:3000/admin/login)
  * **Email:** `admin@phsarroeung.com`
  * **Password:** `admin123`

---

## 🤖 របៀបភ្ជាប់ជាមួយ Telegram Bot ពិតប្រាកដ

១. ចូលទៅកាន់ Telegram រួចស្វែងរក **@BotFather**
២. វាយពាក្យបញ្ជា `/newbot` ដើម្បីបង្កើត Bot ថ្មី និងយក **Bot Token**
៣. បើក File `.env` នៅក្នុង Folder នេះ រួចបំពេញ៖
   ```env
   BOT_TOKEN=យក_TOKEN_ពី_BotFather_មកដាក់ទីនេះ
   WEBAPP_URL=https://your-domain-or-ngrok-url.com
   ```
៤. ដំណើរការ Bot តាមរយៈ៖
   ```bash
   npm run bot
   ```
៥. នៅលើ **@BotFather** វាយបញ្ជា `/setmenubutton` រួចជ្រើសរើស Bot របស់អ្នក ហើយដាក់ Link WebApp របស់អ្នកដើម្បីឱ្យមានប៊ូតុង Menu ជាប់នៅខាងក្រោម Bot ជានិច្ច!

---

## 📁 រចនាសម្ព័ន្ធ Folder (Structure)

* `public/` - ផ្ទុក Frontend Mini App, Logo, និង Resource CSS/JS
* `routes/` - API Endpoints (Auth, Movies, Purchase, Topup, VIP, Comments, Admin)
* `data/db.json` - កន្លែងផ្ទុកទិន្នន័យ (Movies, Users, Balances, Purchases, Comments)
* `server.js` - Express Server
* `bot.js` - Telegram Bot Script
* `.env` - ការកំណត់ Bot Token និង Port
