// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyB3c9gHbY4MtNNErG5cDwVT1t1dwUoUHGQ",
  authDomain: "mop-pvl.firebaseapp.com",
  projectId: "mop-pvl",
  storageBucket: "mop-pvl.firebasestorage.app",
  messagingSenderId: "327040886662",
  appId: "1:327040886662:web:3ac751778ca9c917092e07",
  measurementId: "G-8DL0ZC1K0X"
};


firebase.initializeApp(firebaseConfig);

// Глобальные переменные Firebase
window.auth = firebase.auth();
window.db = firebase.firestore();
window.storage = firebase.storage();

console.log('✅ Firebase инициализирован');





try {
    firebase.initializeApp(firebaseConfig);
    console.log('✅ Firebase инициализирован');
} catch (error) {
    console.error('❌ Ошибка инициализации Firebase:', error);
}

// Делаем переменные глобальными (доступными везде)
window.auth = firebase.auth();
window.db = firebase.firestore();
window.storage = firebase.storage();

console.log('✅ Firebase сервисы созданы:', {
    auth: !!window.auth,
    db: !!window.db,
    storage: !!window.storage
});

