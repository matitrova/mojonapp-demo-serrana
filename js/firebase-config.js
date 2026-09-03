// Config del proyecto Firebase (MojonApp). No es información secreta: la
// seguridad real la dan las reglas de Firestore/Auth (ver firestore.rules),
// no ocultar estos valores. Para apuntar la app a otro proyecto, se cambia
// solo acá.
//
// Este deploy es la demo aislada "mojonapp-demo-serrana" — un proyecto
// Firebase propio, separado del original, para embeber en la landing de
// Raíz Serrana sin mezclar datos de ejemplo con la cartera real.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBX8P7hKkUZarGuFdNea6Sl7JtX1f3m9v4",
  authDomain: "mojonapp-demo-serrana.firebaseapp.com",
  projectId: "mojonapp-demo-serrana",
  storageBucket: "mojonapp-demo-serrana.firebasestorage.app",
  messagingSenderId: "759809397310",
  appId: "1:759809397310:web:37aab077b48a85c423776f"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
// Se reexporta el config para el panel de administración: dar de alta un
// corredor nuevo levanta una segunda instancia de Firebase App/Auth en
// memoria (initializeApp(firebaseConfig, "alta-...")) para que crear esa
// cuenta no pise la sesión de quien la está creando.
export { firebaseConfig };
