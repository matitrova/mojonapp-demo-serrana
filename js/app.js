// ---------------------------------------------------------------------------
// MojonApp. Los lotes viven en Firestore (colección "lotes"): cualquiera
// que abra la app los puede ver, pero solo un corredor logueado (Firebase
// Auth) puede cargar uno nuevo. Ver firebase-config.js y firestore.rules.
// ---------------------------------------------------------------------------

import { db, auth } from "./firebase-config.js";
import {
  getLoteSeleccionado,
  setCorredorLogueado,
  setMiPerfil,
  setSectoresActuales,
  setBarriosActuales,
  setLoteEditadoDesdeFicha,
  emitirSesionCerrada
} from "./estado.js";
import { tienePermiso, puedeEditarLote, puedeBorrarLote, esRootActual } from "./permisos.js";
import { iniciarEstoyYendo } from "./estoy-yendo.js";
import {
  configurarCatalogos,
  iniciarCatalogos,
  cargarSectores,
  cargarBarrios,
  poblarSelectSector,
  poblarSelectBarrio
} from "./catalogos.js";
import { configurarDashboard, abrirPanelDashboard, renderDashboard } from "./dashboard.js";
import { configurarVistaLista } from "./vista-lista.js";
import { configurarEditorForma } from "./editor-forma.js";
import { configurarCargarLote } from "./cargar-lote.js";
import {
  mapa,
  cargarLotesDesdeFirestore,
  anilloAGeometryFirestore,
  configurarMapa,
  iniciarMapa
} from "./mapa.js";
import {
  mostrarFicha,
  tituloLote,
  contenidoTooltipLote,
  borrarLote,
  cerrarEditorServicios,
  cerrarEditorSector,
  cerrarEditorBarrio,
  abrirLoteDesdeUrlSiCorresponde
} from "./ficha.js";
import "./admin.js";
import "./auditoria.js";
import {
  collection,
  getDocs,
  getDoc,
  addDoc,
  deleteDoc,
  updateDoc,
  setDoc,
  doc,
  query,
  where,
  increment
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

configurarCatalogos({ db, getDocs, addDoc, setDoc, deleteDoc, collection, doc });
iniciarCatalogos();

const ETIQUETA_ESTADO = {
  disponible: "Disponible",
  reservado: "Reservado",
  vendido: "Vendido"
};

// Texto de estado listo para mostrar, con la fecha de vencimiento de la
// reserva si corresponde ("Reservado (hasta 15/09/2026)" o "Reservado
// (vencida desde 10/09/2026)" en rojo) — para que un lote reservado
// hace rato y nunca actualizado no pase desapercibido. HTML porque el
// "vencida" va en rojo (.texto-vencido); si no hay fecha, se devuelve
// como texto plano (sin riesgo: ETIQUETA_ESTADO no trae HTML).
function textoEstadoConVencimiento(p) {
  const base = ETIQUETA_ESTADO[p.estado] || p.estado;
  if (p.estado !== "reservado" || !p.reservado_hasta) return base;
  const hoy = new Date().toISOString().slice(0, 10);
  const fecha = new Date(`${p.reservado_hasta}T00:00:00`).toLocaleDateString("es-AR");
  return p.reservado_hasta < hoy
    ? `${base} <span class="texto-vencido">(vencida desde ${fecha})</span>`
    : `${base} (hasta ${fecha})`;
}

// Servicios que puede tener un lote (luz, agua, gas, cloaca). El catastro
// no trae este dato — solo se carga a mano ("Cargar a mano"), así que la
// mayoría de los lotes importados de "+ Manzana"/"+ Parcela" no van a
// tener el campo `servicios` en absoluto. Se distingue "sin dato" (no se
// muestra nada) de "no tiene el servicio" (chip apagado) — ver
// renderServiciosHTML.
const SERVICIOS_INFO = [
  { clave: "luz", icono: "⚡", etiqueta: "Luz" },
  { clave: "agua", icono: "🚰", etiqueta: "Agua" },
  { clave: "gas", icono: "🔥", etiqueta: "Gas" },
  { clave: "cloaca", icono: "🚽", etiqueta: "Cloaca" }
];

function renderServiciosHTML(servicios) {
  if (servicios == null) return "Sin datos";
  return SERVICIOS_INFO.map(({ clave, icono, etiqueta }) => {
    const tiene = !!servicios[clave];
    return `<span class="chip-servicio${tiene ? "" : " sin-servicio"}">${icono} ${etiqueta}</span>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Hojas inferiores (ficha, login, y los formularios de carga): todas
// comparten la misma posición fija en la parte de abajo de la pantalla,
// así que abrir una sin cerrar las demás las deja superpuestas. Cualquier
// botón que abra una hoja pasa por acá para cerrar el resto primero.
// ---------------------------------------------------------------------------

function abrirHoja(elHoja) {
  document.querySelectorAll(".hoja-inferior").forEach((hoja) => {
    if (hoja !== elHoja) hoja.classList.add("oculto");
  });
  elHoja.classList.remove("oculto");
}

// ---------------------------------------------------------------------------
// Menú lateral (drawer): todas las secciones/subsecciones de la app en
// un solo lugar, para no seguir amontonando botones en el header a
// medida que se suman funciones nuevas.
// ---------------------------------------------------------------------------

const elBtnMenu = document.getElementById("btn-menu");
const elDrawerMenu = document.getElementById("drawer-menu");
const elDrawerOverlay = document.getElementById("drawer-overlay");

function abrirDrawer() {
  elDrawerMenu.classList.remove("oculto");
  elDrawerOverlay.classList.remove("oculto");
}

function cerrarDrawer() {
  elDrawerMenu.classList.add("oculto");
  elDrawerOverlay.classList.add("oculto");
}

elBtnMenu.addEventListener("click", abrirDrawer);
document.getElementById("cerrar-drawer").addEventListener("click", cerrarDrawer);
elDrawerOverlay.addEventListener("click", cerrarDrawer);

// Elegir cualquier acción del menú cierra el drawer: casi todas abren
// otra hoja o panel encima del mapa, así que dejarlo abierto tapando
// todo no sirve.
document.querySelectorAll(".drawer-item").forEach((boton) => {
  boton.addEventListener("click", cerrarDrawer);
});

// Subsecciones plegables (genérico: cualquier ".drawer-grupo-titulo"
// nuevo que se agregue más adelante ya funciona solo, sin tocar este
// código de nuevo). Arrancan cerradas para que la lista no se alargue
// sola a medida que se sumen más secciones.
document.querySelectorAll(".drawer-grupo-titulo").forEach((boton) => {
  const items = boton.nextElementSibling;
  boton.addEventListener("click", () => {
    const abierto = boton.classList.toggle("abierto");
    items.classList.toggle("oculto", !abierto);
  });
});

// Wiring de los módulos que necesitan mapa/mostrarFicha/etc. — todos
// estos valores ya están disponibles como imports acá arriba (mapa.js,
// ficha.js, permisos.js, catalogos.js no tienen ninguna dependencia
// circular real hacia acá, así que no hace falta pasarles nada a mano
// salvo lo que sigue viviendo directo en este archivo: la instancia de
// Firestore/Auth).
configurarEditorForma({
  db,
  doc,
  updateDoc,
  mapa,
  mostrarFicha,
  tituloLote,
  cargarLotesDesdeFirestore,
  anilloAGeometryFirestore
});

configurarMapa({ mostrarFicha, contenidoTooltipLote });
// Encadenado: reaplica el centrado del deep link ("?lote=") si esta carga
// (la que pinta rápido, antes de saber si hay sesión) termina después que
// la de onAuthStateChanged más abajo — ver el comentario en
// abrirLoteDesdeUrlSiCorresponde (ficha.js).
iniciarMapa().then(() => abrirLoteDesdeUrlSiCorresponde());

configurarVistaLista({
  db,
  doc,
  updateDoc,
  getDocs,
  query,
  collection,
  where,
  mapa,
  mostrarFicha,
  tituloLote,
  puedeEditarLote,
  puedeBorrarLote,
  borrarLote,
  cargarLotesDesdeFirestore,
  textoEstadoConVencimiento,
  renderServiciosHTML
});
configurarDashboard({ db, doc, updateDoc, increment, mapa, mostrarFicha, tituloLote });
configurarCargarLote({ mapa, cargarLotesDesdeFirestore, anilloAGeometryFirestore });

iniciarEstoyYendo();

// ---------------------------------------------------------------------------
// Sesión del corredor (Firebase Auth): lectura de lotes es pública, cargar
// uno nuevo requiere estar logueado (ver firestore.rules).
// ---------------------------------------------------------------------------

const elBtnAbrirLogin = document.getElementById("btn-abrir-login");
const elSesionActiva = document.getElementById("sesion-activa");
const elSesionEmail = document.getElementById("sesion-email");
const elBtnCargarLote = document.getElementById("btn-cargar-lote");
const elBtnSalir = document.getElementById("btn-salir");

const elFormLogin = document.getElementById("form-login");
const formularioLogin = document.getElementById("formulario-login");
const elLoginEmail = document.getElementById("login-email");
const elLoginPassword = document.getElementById("login-password");
const elLoginError = document.getElementById("login-error");

elBtnAbrirLogin.addEventListener("click", () => abrirHoja(elFormLogin));
document.getElementById("cerrar-login").addEventListener("click", () => elFormLogin.classList.add("oculto"));

formularioLogin.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elLoginError.classList.add("oculto");
  try {
    await signInWithEmailAndPassword(auth, elLoginEmail.value.trim(), elLoginPassword.value);
    formularioLogin.reset();
    elFormLogin.classList.add("oculto");
    // Se abre YA, en la misma continuación síncrona del login — no
    // espera a que termine cargarLotesDesdeFirestore() (dispara aparte,
    // desde onAuthStateChanged, y es un pedido real a Firestore). Abrir
    // acá evita una carrera: si se esperara a esa carga, alcanzaba a
    // pasar un instante en el que el usuario ya había navegado a otra
    // parte (la ficha de un lote, por ejemplo) y el dashboard aparecía
    // de golpe encima, tapándola. Puede arrancar mostrando números
    // desactualizados por una fracción de segundo — se refresca solo
    // cuando esa carga efectivamente termine, ver onAuthStateChanged.
    abrirPanelDashboard();
  } catch (error) {
    elLoginError.textContent = "Email o contraseña incorrectos.";
    elLoginError.classList.remove("oculto");
  }
});

elBtnSalir.addEventListener("click", () => signOut(auth));

// Resuelve el perfil de seguridad del usuario logueado: lee su doc en
// "usuarios" para saber qué perfil tiene asignado, y ese perfil en
// "perfiles" para saber qué puede hacer. Si cualquiera de los dos pasos
// falla (cuenta sin perfil asignado todavía, o borrado a mano) se trata
// como sin permisos — nunca como root ni con acceso de más.
async function resolverMiPerfil(usuario) {
  try {
    const docUsuario = await getDoc(doc(db, "usuarios", usuario.uid));
    const perfilId = docUsuario.exists() ? docUsuario.data().perfil_id : null;
    if (!perfilId) return null;
    const docPerfil = await getDoc(doc(db, "perfiles", perfilId));
    return docPerfil.exists() ? docPerfil.data() : null;
  } catch {
    return null;
  }
}

// Muestra/oculta los botones que dependen de un permiso puntual (no de
// "estar logueado" nomás). Se llama después de resolver miPerfilActual,
// y de nuevo si root reasigna el perfil de alguien desde "Administrar".
function actualizarUIPorPermisos() {
  document.getElementById("btn-abrir-manzana").classList.toggle("oculto", !tienePermiso("cargar_lote"));
  document.getElementById("btn-abrir-parcela").classList.toggle("oculto", !tienePermiso("cargar_lote"));
  elBtnCargarLote.classList.toggle("oculto", !tienePermiso("cargar_lote"));
  document.getElementById("drawer-grupo-seguridad").classList.toggle("oculto", !tienePermiso("administrar_usuarios"));
  // A diferencia de "Usuarios"/"Perfiles de seguridad" (permiso
  // administrar_usuarios, que un corredor no-root puede tener), "quién
  // hizo qué" es exclusivamente de root — esRootActual() directo, no
  // tienePermiso().
  document.getElementById("btn-abrir-auditoria").classList.toggle("oculto", !esRootActual());
  // Sectores es un permiso propio, distinto de "administrar_usuarios": un
  // corredor puede organizar su propia cartera en zonas sin depender de
  // root, y root puede sacarle ese permiso puntual sin tocarle el resto.
  // Mismo criterio en firestore.rules.
  document.getElementById("drawer-grupo-sectores").classList.toggle("oculto", !tienePermiso("administrar_sectores"));
}

onAuthStateChanged(auth, async (usuario) => {
  setCorredorLogueado(!!usuario);
  setMiPerfil(usuario ? await resolverMiPerfil(usuario) : null);

  if (usuario) {
    elBtnAbrirLogin.classList.add("oculto");
    elSesionActiva.classList.remove("oculto");
    document.getElementById("drawer-sesion-activa").classList.remove("oculto");
    elSesionEmail.textContent = usuario.email;
    actualizarUIPorPermisos();
    // El catálogo de zonas/barrios necesita sesión para leerse (ver
    // firestore.rules), así que se carga acá y no al arrancar la app.
    await cargarSectores();
    await cargarBarrios();
    const elLoteSectorForm = document.getElementById("lote-sector");
    const elLoteBarrioForm = document.getElementById("lote-barrio");
    poblarSelectSector(elLoteSectorForm, elLoteSectorForm.value);
    poblarSelectBarrio(elLoteBarrioForm, elLoteBarrioForm.value);
  } else {
    elBtnAbrirLogin.classList.remove("oculto");
    elSesionActiva.classList.add("oculto");
    document.getElementById("drawer-sesion-activa").classList.add("oculto");
    setSectoresActuales([]);
    setBarriosActuales([]);
    // Cerrar sesión apaga todas las herramientas de corredor, no solo
    // "+ Lote": sin esto, si alguien cerraba sesión con "Ver catastro
    // cercano" prendido (o cualquier otro panel abierto), el botón para
    // apagarlo desaparecía junto con el resto de la barra, pero la capa
    // seguía activa y pidiéndole datos al catastro en cada movimiento del
    // mapa, visible para cualquiera que mirara la app después.
    emitirSesionCerrada();
  }

  // Si la ficha de un lote está abierta al cambiar de sesión (login,
  // logout, o root reasignando el perfil de alguien), "Borrar lote" y
  // "Editar servicios"/"Editar sector" tienen que reflejar el permiso
  // nuevo sin esperar a que se cierre y se vuelva a abrir.
  if (getLoteSeleccionado()) {
    document.getElementById("btn-borrar-lote").classList.toggle("oculto", !puedeBorrarLote(getLoteSeleccionado()));
    document.getElementById("btn-editar-lote-completo").classList.toggle("oculto", !puedeEditarLote(getLoteSeleccionado()));
    document.getElementById("btn-editar-forma-lote").classList.toggle("oculto", !puedeEditarLote(getLoteSeleccionado()));
    document.getElementById("ficha-interesados").classList.toggle("oculto", !puedeEditarLote(getLoteSeleccionado()));
    cerrarEditorServicios();
    cerrarEditorSector();
    cerrarEditorBarrio();
  }

  // El alcance de la consulta a Firestore depende del permiso
  // "ver_todos_los_lotes" (ver cargarLotesDesdeFirestore): tiene que
  // volver a pedirse cada vez que cambia quién está logueado, no solo al
  // arrancar la app.
  cargarLotesDesdeFirestore().then(() => {
    abrirLoteDesdeUrlSiCorresponde();
    // Si el dashboard se abrió recién (ver formularioLogin más arriba)
    // con datos todavía viejos/vacíos, esto lo refresca con los reales
    // apenas terminan de llegar. Si para entonces ya está cerrado (el
    // usuario navegó a otra parte), no hace nada visible — recalcular
    // el contenido de un panel oculto es inofensivo.
    if (!document.getElementById("panel-dashboard").classList.contains("oculto")) renderDashboard();
  });
});

