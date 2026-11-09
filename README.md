# Perera Cars

Tracks income, expenses and oil changes for the family cars. It runs on iPhone as a home-screen app, works offline, and syncs between phones through Firebase.

**What's in the app**
- **Cars tab:** each car is shown by its register number. Tap a car to open it, press and hold to rename it, and use **＋ Add car** to add one.
- **Car page:** this month's (or all-time) income, expenses, oil changes and profit, the oil change status ("due in 4,100 km"), and the records list. You can filter the list by type and tap any record to edit or delete it.
- **Big + button:** one quick form with an **Income / Expense** toggle. Expense categories include **Fuel** (optional litres) and **Oil change** (optional odometer and next-due km). Income categories are Wedding hire, Photoshoot, Airport hire, Normal hire and Other. Only the amount is required.
- **Reports tab:** a per-car table for the chosen month, spending by category, and the last 12 months.
- **Settings tab:** your name (saved as "added by" on each record), the oil change interval, Backup, Restore, and Export to Excel (CSV).
- Amounts are in LKR and shown like `Rs 12,500`.

Until step 1 is done, the app runs in **local mode**, which keeps data only on the phone it was entered on.

---

## Step 1: Firebase (live sync between phones). Free, about 10 minutes.

1. Go to https://console.firebase.google.com and click **Add project**. Name it (e.g. `perera-cars`). You can turn Analytics off.
2. Set up a database: **Build → Firestore Database → Create database**. Choose the location `asia-south1` (Mumbai), the closest one to Sri Lanka, and start in **production mode**.
3. Set up sign-in: **Build → Authentication → Get started → Email/Password → Enable**.
   Then go to **Users → Add user** and create ONE family account, e.g. `ourcars@gmail.com` with a strong password. Everyone signs in with this account.
4. Lock the database: **Firestore → Rules**. Paste the contents of `firestore.rules`, replace `family@example.com` with the family email from step 3, and click **Publish**.
5. Get the web config: **Project settings (gear icon) → General → Your apps → Web (`</>`)**. Register the app; you don't need Hosting. Firebase shows a `firebaseConfig = {...}` block.
6. Open `firebase-config.js` and replace `null` with that object:
   ```js
   export const FIREBASE_CONFIG = {
     apiKey: "...",
     authDomain: "...",
     projectId: "...",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "..."
   };
   ```
   This config is not a secret. It is safe in a public repo, because the rules from step 4 protect the data.
7. After you finish step 2 below, go back to Firebase: **Authentication → Settings → Authorized domains → Add domain**, and add `tharuushi.github.io`.

## Step 2: Put it on GitHub Pages. Free.

1. Create a GitHub account if you don't have one, then click **New repository**. Name it `Perera_Cars` and make it **Public**. (A private repo needs a paid plan to use Pages.)
2. Click **Add file → Upload files**, drag in **all files and the `icons` folder** from this folder, then click **Commit**.
3. Go to **Settings → Pages**. Under "Build and deployment" choose **Deploy from a branch**, select branch `main` and folder `/ (root)`, and click **Save**.
4. After about a minute the app is live at `https://tharuushi.github.io/Perera_Cars/`.

## Step 3: Install on each iPhone

1. Open the link in **Safari**. It must be Safari, not Chrome.
2. Tap **Share** (the square with the up arrow), then **Add to Home Screen**, then **Add**.
3. Open **Perera Cars** from the home screen and sign in with the family account.
4. Go to **Settings** and enter your name, so each record shows who added it.

Do this on each phone. All phones then see the same cars and records. Records added without internet are saved and synced automatically when the phone is back online.

## Updating the app later
Upload the changed files to the GitHub repo again. If a phone still shows the old version, close the app fully and open it twice.

## Backups
Settings → **Backup** creates a `.json` file that you can save to Files, iCloud or WhatsApp. **Restore** loads such a file. In cloud mode, a restore replaces the data on all phones.
