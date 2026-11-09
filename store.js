// Data layer. Two implementations with the same interface:
//  - LocalStore: data kept only on this phone (used when Firebase is not configured)
//  - FirebaseStore: live sync between phones through Cloud Firestore (works offline too)
//
// Interface:
//   start(onData, onAuth)   onData({cars, records}) is called whenever data changes
//   addCar / updateCar / deleteCar
//   addRecord / updateRecord / deleteRecord
//   replaceAll({cars, records})       used by Restore
//   signIn(email, pw) / signOut()     (Firebase only)
//   mode: 'local' | 'cloud'

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const LS_KEY = 'carledger.data.v1';

export class LocalStore {
  constructor() {
    this.mode = 'local';
    this.data = { cars: [], records: [] };
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) this.data = JSON.parse(raw);
    } catch (e) { /* storage unavailable */ }
    this.data.cars ||= [];
    this.data.records ||= [];
  }
  start(onData, onAuth) {
    this.onData = onData;
    onAuth && onAuth({ signedIn: true, email: null });
    this.emit();
  }
  emit() { this.onData && this.onData(structuredClone(this.data)); }
  save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.data)); } catch (e) { /* ignore */ }
    this.emit();
  }
  async addCar(car) { this.data.cars.push({ id: newId(), createdAt: Date.now(), ...car }); this.save(); }
  async updateCar(id, patch) { const c = this.data.cars.find(c => c.id === id); if (c) Object.assign(c, patch); this.save(); }
  async deleteCar(id) {
    this.data.cars = this.data.cars.filter(c => c.id !== id);
    this.data.records = this.data.records.filter(r => r.carId !== id);
    this.save();
  }
  async addRecord(rec) { this.data.records.push({ id: newId(), createdAt: Date.now(), ...rec }); this.save(); }
  async updateRecord(id, patch) { const r = this.data.records.find(r => r.id === id); if (r) Object.assign(r, patch); this.save(); }
  async deleteRecord(id) { this.data.records = this.data.records.filter(r => r.id !== id); this.save(); }
  async replaceAll(d) { this.data = { cars: d.cars || [], records: d.records || [] }; this.save(); }
}

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';

export class FirebaseStore {
  constructor(config, fleetId = 'main') {
    this.mode = 'cloud';
    this.config = config;
    this.fleetId = fleetId;
    this.cars = [];
    this.records = [];
    this.unsubs = [];
  }

  async init() {
    const [{ initializeApp }, authMod, fs] = await Promise.all([
      import(FB + 'firebase-app.js'),
      import(FB + 'firebase-auth.js'),
      import(FB + 'firebase-firestore.js'),
    ]);
    this.authMod = authMod;
    this.fs = fs;
    const app = initializeApp(this.config);
    this.auth = authMod.getAuth(app);
    try {
      // Offline cache: the app keeps working without internet and syncs later.
      this.db = fs.initializeFirestore(app, {
        localCache: fs.persistentLocalCache({ tabManager: fs.persistentSingleTabManager() }),
      });
    } catch (e) {
      this.db = fs.getFirestore(app);
    }
  }

  col(name) { return this.fs.collection(this.db, 'fleets', this.fleetId, name); }
  ref(name, id) { return this.fs.doc(this.db, 'fleets', this.fleetId, name, id); }

  start(onData, onAuth) {
    this.onData = onData;
    this.authMod.onAuthStateChanged(this.auth, user => {
      this.unsubs.forEach(u => u()); this.unsubs = [];
      if (!user) { this.cars = []; this.records = []; onAuth({ signedIn: false }); return; }
      onAuth({ signedIn: true, email: user.email });
      const err = e => { console.error(e); onAuth({ signedIn: true, email: user.email, error: e.message }); };
      this.unsubs.push(this.fs.onSnapshot(this.col('cars'), { includeMetadataChanges: true }, snap => {
        this.cars = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        this.pending = snap.metadata.hasPendingWrites;
        this.emit();
      }, err));
      this.unsubs.push(this.fs.onSnapshot(this.col('records'), { includeMetadataChanges: true }, snap => {
        this.records = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        this.pending = snap.metadata.hasPendingWrites;
        this.emit();
      }, err));
    });
  }
  emit() { this.onData && this.onData({ cars: this.cars, records: this.records, pending: this.pending }); }

  // Writes are not awaited on the server: offline writes are queued and
  // sent automatically when the phone is back online.
  w(p) { p.catch(e => { console.error(e); alert('Could not save: ' + e.message); }); }

  async signIn(email, pw) { await this.authMod.signInWithEmailAndPassword(this.auth, email, pw); }
  async signOut() { await this.authMod.signOut(this.auth); }

  async addCar(car) { this.w(this.fs.setDoc(this.ref('cars', newId()), { createdAt: Date.now(), ...car })); }
  async updateCar(id, patch) { this.w(this.fs.updateDoc(this.ref('cars', id), patch)); }
  async deleteCar(id) {
    const refs = [this.ref('cars', id), ...this.records.filter(r => r.carId === id).map(r => this.ref('records', r.id))];
    await this.batchDo(refs.map(r => b => b.delete(r)));
  }
  async addRecord(rec) { this.w(this.fs.setDoc(this.ref('records', newId()), { createdAt: Date.now(), ...rec })); }
  async updateRecord(id, patch) { this.w(this.fs.updateDoc(this.ref('records', id), patch)); }
  async deleteRecord(id) { this.w(this.fs.deleteDoc(this.ref('records', id))); }

  async replaceAll(d) {
    const ops = [];
    this.cars.forEach(c => ops.push(b => b.delete(this.ref('cars', c.id))));
    this.records.forEach(r => ops.push(b => b.delete(this.ref('records', r.id))));
    (d.cars || []).forEach(({ id, ...rest }) => ops.push(b => b.set(this.ref('cars', id || newId()), rest)));
    (d.records || []).forEach(({ id, ...rest }) => ops.push(b => b.set(this.ref('records', id || newId()), rest)));
    await this.batchDo(ops);
  }

  async batchDo(ops) {
    for (let i = 0; i < ops.length; i += 400) {
      const b = this.fs.writeBatch(this.db);
      ops.slice(i, i + 400).forEach(op => op(b));
      this.w(b.commit());
    }
  }
}
