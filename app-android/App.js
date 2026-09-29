import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, StyleSheet, StatusBar,
  ActivityIndicator, SafeAreaView, Platform, TouchableOpacity,
  FlatList, Modal,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Picker } from '@react-native-picker/picker';
import Svg, { Path, Rect, Circle } from 'react-native-svg';

const STORAGE_KEY   = 'cambio_rapido_rates_v3';
const HISTORY_KEY   = 'cambio_rapido_history_v3';
const HISTORY_MONTH_KEY = 'cambio_rapido_history_month';

// ── Venezuela UTC offset: 4h = 14400000ms ──────────────────────
const VE_OFFSET_MS = 14400000;

// ── Inicio del dia en Caracas → timestamp UTC ms ───────────────
function dayStartMs(dateMs) {
  const d = new Date(dateMs - VE_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + VE_OFFSET_MS;
}

// ──────────────────────────────────────────────────────────────
// Logo
// ──────────────────────────────────────────────────────────────
function AppLogo() {
  return (
    <Svg width={70} height={70} viewBox="0 0 48 48">
      <Path fill="#EA4335" d="M24 24H4c0 11.05 8.95 20 20 20v-20z"/>
      <Path fill="#FBBC05" d="M24 24v20c11.05 0 20-8.95 20-20H24z"/>
      <Path fill="#34A853" d="M24 24h20c0-11.05-8.95-20-20-20v20z"/>
      <Path fill="#4285F4" d="M24 24V4C12.95 4 4 12.95 4 24h20z"/>
      <Circle fill="#121212" cx={28} cy={24} r={8}/>
      <Rect fill="#121212" x={0} y={0} width={14} height={48}/>
    </Svg>
  );
}

function RefreshIcon({ spinning }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Path fill="none" stroke={spinning ? '#555' : '#6DD58C'} strokeWidth={2.2}
        strokeLinecap="round" strokeLinejoin="round" d="M23 4v6h-6M1 20v-6h6"/>
      <Path fill="none" stroke={spinning ? '#555' : '#6DD58C'} strokeWidth={2.2}
        strokeLinecap="round"
        d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
    </Svg>
  );
}

function HistoryIcon() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Path fill="none" stroke="#A8C7FA" strokeWidth={2} strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </Svg>
  );
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
function formatMoney(amount) {
  if (isNaN(amount) || amount === null) return '0,00';
  const fixed = Number(amount).toFixed(2);
  const [int, dec] = fixed.split('.');
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${intFmt},${dec}`;
}

function rawToAmount(text) {
  const digits = String(text || '').replace(/\D/g, '');
  return digits ? parseInt(digits, 10) / 100 : 0;
}

function formatDateLabel(timestampMs) {
  if (!timestampMs) return '';
  const d = new Date(timestampMs);
  const label = d.toLocaleDateString('es-VE', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Caracas',
  });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatSavedAt(timestampMs) {
  if (!timestampMs) return '';
  const d = new Date(timestampMs);
  const time = d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Caracas' });
  const date = d.toLocaleDateString('es-VE', { day: 'numeric', month: 'short', timeZone: 'America/Caracas' });
  return `${date} ${time}`;
}

// ──────────────────────────────────────────────────────────────
// API pública: DolarApi Venezuela (https://ve.dolarapi.com)
// ──────────────────────────────────────────────────────────────
const API_BASE = 'https://ve.dolarapi.com/v1';

async function apiGet(path, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

// "2026-09-28" o ISO completo → timestamp del inicio de ese dia en Caracas
function isoToDayMs(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return Date.UTC(y, m - 1, d) + VE_OFFSET_MS;
}

// ──────────────────────────────────────────────────────────────
// Fetch tasa actual (dolar oficial BCV)
// ──────────────────────────────────────────────────────────────
async function fetchCurrentRates() {
  const oficial = await apiGet('/dolares/oficial');
  const rate = oficial?.promedio;
  if (!rate || rate <= 0) throw new Error('Sin datos');
  const now = Date.now();
  const dayMs = isoToDayMs(oficial.fechaActualizacion) ?? dayStartMs(now);
  // El BCV publica por adelantado la tasa del proximo dia habil
  const prefix = dayMs > dayStartMs(now) ? 'Proxima BCV' : 'Tasa BCV';
  return [{
    id: 'bcv_actual',
    label: `${prefix}  ${formatDateLabel(dayMs)}`,
    rate,
    dateBcvMs: dayMs,
    savedAt: now,
  }];
}

// ──────────────────────────────────────────────────────────────
// Historial del mes actual.
// Combina el endpoint de historicos de DolarApi con las tasas que la
// propia app va guardando cada vez que consulta la tasa del dia.
// ──────────────────────────────────────────────────────────────
async function fetchMonthHistory(existingHistory = [], currentRates = []) {
  const today = Date.now();
  const veDate = new Date(today - VE_OFFSET_MS);
  const monthStart = Date.UTC(veDate.getUTCFullYear(), veDate.getUTCMonth(), 1) + VE_OFFSET_MS;

  const newEntries = [];
  try {
    const hist = await apiGet('/historicos/dolares/oficial', 10000);
    for (const h of Array.isArray(hist) ? hist : []) {
      const dayMs = isoToDayMs(h.fecha);
      if (dayMs && dayMs >= monthStart && h.promedio > 0) {
        newEntries.push({ dateBcvMs: dayMs, rate: h.promedio, label: formatDateLabel(dayMs) });
      }
    }
  } catch (_) {
    // Sin conexion o endpoint caido: se usa lo que ya hay en cache
  }

  for (const r of currentRates) {
    if (r.dateBcvMs && r.rate > 0) {
      newEntries.push({ dateBcvMs: r.dateBcvMs, rate: r.rate, label: formatDateLabel(r.dateBcvMs) });
    }
  }

  // Combinar, quedarse solo con el mes actual y ordenar de mas reciente a mas antiguo
  const combined = [...newEntries, ...existingHistory].filter(h => h.dateBcvMs >= monthStart);
  combined.sort((a, b) => b.dateBcvMs - a.dateBcvMs);

  // Deduplicar por dia
  const seen = new Set();
  return combined.filter(h => {
    if (seen.has(h.dateBcvMs)) return false;
    seen.add(h.dateBcvMs);
    return true;
  });
}

// ──────────────────────────────────────────────────────────────
// App
// ──────────────────────────────────────────────────────────────
export default function App() {
  const [usdValue,     setUsdValue]     = useState('0,00');
  const [bsValue,      setBsValue]      = useState('0,00');
  const [rates,        setRates]        = useState([]);
  const [selectedId,   setSelectedId]   = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [statusMsg,    setStatusMsg]    = useState('Iniciando...');
  const [isOffline,    setIsOffline]    = useState(false);
  const [showHistory,  setShowHistory]  = useState(false);
  const [history,      setHistory]      = useState([]);
  const [loadingHist,  setLoadingHist]  = useState(false);

  const lastEdited = useRef('usd');
  const selectedRate = rates.find(r => r.id === selectedId)?.rate ?? 0;

  // ── Inputs (Estilo cajero: de derecha a izquierda) ────────────
  function handleUsdInput(text) {
    lastEdited.current = 'usd';
    const amount = rawToAmount(text);
    setUsdValue(formatMoney(amount));
    if (selectedRate > 0) setBsValue(formatMoney(amount * selectedRate));
  }

  function handleBsInput(text) {
    lastEdited.current = 'bs';
    const amount = rawToAmount(text);
    setBsValue(formatMoney(amount));
    if (selectedRate > 0) setUsdValue(formatMoney(amount / selectedRate));
  }

  function onRateChange(id) {
    setSelectedId(id);
    const rate = rates.find(r => r.id === id)?.rate ?? 0;
    if (rate <= 0) return;
    if (lastEdited.current === 'usd') {
      const amount = rawToAmount(usdValue);
      setBsValue(formatMoney(amount * rate));
    } else {
      const amount = rawToAmount(bsValue);
      setUsdValue(formatMoney(amount / rate));
    }
  }

  // ── Cache ──────────────────────────────────────────────────────
  async function saveCache(rateList) {
    try { await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(rateList)); } catch {}
  }
  async function loadCache() {
    try { const s = await AsyncStorage.getItem(STORAGE_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
  }
  async function saveHistoryCache(h) {
    try { await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch {}
  }
  async function loadHistoryCache() {
    try {
      // Borrar historial si cambia el mes (en hora Caracas)
      const nowVE   = new Date(Date.now() - VE_OFFSET_MS);
      const curMonth = `${nowVE.getUTCFullYear()}-${nowVE.getUTCMonth()}`;
      const storedMonth = await AsyncStorage.getItem(HISTORY_MONTH_KEY);
      if (storedMonth !== null && storedMonth !== curMonth) {
        await AsyncStorage.removeItem(HISTORY_KEY);
        await AsyncStorage.setItem(HISTORY_MONTH_KEY, curMonth);
        return [];
      }
      await AsyncStorage.setItem(HISTORY_MONTH_KEY, curMonth);
      const s = await AsyncStorage.getItem(HISTORY_KEY);
      return s ? JSON.parse(s) : [];
    } catch { return []; }
  }

  // ── Fetch tasas actuales ──────────────────────────────────────
  const doFetch = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    else setLoading(true);
    setStatusMsg('Actualizando...');

    let fetched = null;
    try { fetched = await fetchCurrentRates(); } catch (_) {}

    if (fetched && fetched.length > 0) {
      await saveCache(fetched);
      setRates(fetched);
      setSelectedId(fetched[0].id);
      setIsOffline(false);
      setStatusMsg('');
    } else {
      const cached = await loadCache();
      if (cached && cached.length > 0) {
        setRates(cached);
        setSelectedId(cached[0].id);
        setIsOffline(true);
        setStatusMsg(`Sin conexion  datos del ${formatSavedAt(cached[0].savedAt)}`);
      } else {
        setRates([]);
        setSelectedId(null);
        setIsOffline(true);
        setStatusMsg('Sin conexion. Conectate para ver la tasa.');
      }
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { doFetch(false); }, []);

  useEffect(() => {
    if (selectedRate <= 0) return;
    if (lastEdited.current === 'usd') {
      const amount = rawToAmount(usdValue);
      setBsValue(formatMoney(amount * selectedRate));
    } else {
      const amount = rawToAmount(bsValue);
      setUsdValue(formatMoney(amount / selectedRate));
    }
  }, [selectedId]);

  // ── Abrir historial ───────────────────────────────────────────
  async function openHistory() {
    setShowHistory(true);
    setLoadingHist(true);
    const cached = await loadHistoryCache();
    setHistory(cached);
    try {
      const updated = await fetchMonthHistory(cached, rates.filter(r => r.id === 'bcv_actual'));
      setHistory(updated);
      await saveHistoryCache(updated);
    } catch (_) {}
    setLoadingHist(false);
  }

  // ── Usar tasa del historial ───────────────────────────────────
  function useHistoryRate(item) {
    setShowHistory(false);
    const exists = rates.find(r => r.id === `hist_${item.dateBcvMs}`);
    if (!exists) {
      const newRates = [
        { id: `hist_${item.dateBcvMs}`, label: `Tasa BCV  ${item.label}`, rate: item.rate, savedAt: Date.now() },
        ...rates,
      ];
      setRates(newRates);
      setSelectedId(`hist_${item.dateBcvMs}`);
      const rate = item.rate;
      if (lastEdited.current === 'usd') setBsValue(formatMoney(rawToAmount(usdValue) * rate));
      else setUsdValue(formatMoney(rawToAmount(bsValue) / rate));
    } else {
      onRateChange(`hist_${item.dateBcvMs}`);
    }
  }

  // ── Render ─────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor="#121212" />
      <View style={styles.container}>

        {/* Header */}
        <View style={styles.header}>
          <AppLogo />
          <Text style={styles.title}>Cambio Rapido</Text>
          <View style={styles.headerBtns}>
            <TouchableOpacity style={styles.iconBtn} onPress={openHistory} activeOpacity={0.6}>
              <HistoryIcon />
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconBtn} onPress={() => doFetch(true)}
              disabled={refreshing || loading} activeOpacity={0.6}>
              <RefreshIcon spinning={refreshing || loading} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Card */}
        <View style={styles.card}>
          <View style={styles.inputGroup}>
            <Text style={styles.currencyLabel}>$</Text>
            <TextInput style={styles.input} value={usdValue} onChangeText={handleUsdInput}
              keyboardType="numeric" placeholder="0,00"
              placeholderTextColor="#444" selectionColor="#A8C7FA"/>
          </View>
          <View style={styles.inputGroup}>
            <Text style={styles.currencyLabel}>Bs</Text>
            <TextInput style={styles.input} value={bsValue} onChangeText={handleBsInput}
              keyboardType="numeric" placeholder="0,00"
              placeholderTextColor="#444" selectionColor="#A8C7FA"/>
          </View>

          {loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color="#A8C7FA" size="small"/>
              <Text style={styles.loadingText}>{statusMsg}</Text>
            </View>
          ) : rates.length > 0 ? (
            <>
              <View style={styles.pickerWrapper}>
                <Picker selectedValue={selectedId} onValueChange={onRateChange}
                  style={styles.picker} dropdownIconColor="#6DD58C">
                  {rates.map(item => (
                    <Picker.Item key={item.id}
                      label={`${item.label}  ${formatMoney(item.rate)} Bs`}
                      value={item.id}
                      color={Platform.OS === 'android' ? '#6DD58C' : '#1E1E1E'}/>
                  ))}
                </Picker>
              </View>
              {isOffline && <Text style={styles.offlineText}>{statusMsg}</Text>}
            </>
          ) : (
            <Text style={styles.loadingText}>{statusMsg}</Text>
          )}
        </View>
      </View>

      {/* Modal historial */}
      <Modal visible={showHistory} animationType="slide" transparent onRequestClose={() => setShowHistory(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Historial del mes</Text>
              <TouchableOpacity onPress={() => setShowHistory(false)}>
                <Text style={styles.modalClose}>Cerrar</Text>
              </TouchableOpacity>
            </View>

            {loadingHist && history.length === 0 ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator color="#A8C7FA" size="small"/>
                <Text style={styles.loadingText}>Cargando historial...</Text>
              </View>
            ) : (
              <FlatList
                data={history}
                keyExtractor={item => String(item.dateBcvMs)}
                renderItem={({ item }) => (
                  <TouchableOpacity style={styles.histRow} onPress={() => useHistoryRate(item)} activeOpacity={0.7}>
                    <Text style={styles.histDate}>{item.label}</Text>
                    <Text style={styles.histRate}>{formatMoney(item.rate)} Bs</Text>
                  </TouchableOpacity>
                )}
                ListFooterComponent={loadingHist ? (
                  <View style={styles.loadingRow}>
                    <ActivityIndicator color="#A8C7FA" size="small"/>
                    <Text style={styles.loadingText}>Actualizando...</Text>
                  </View>
                ) : null}
              />
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ── Estilos ───────────────────────────────────────────────────
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#121212' },
  container: { flex: 1, backgroundColor: '#121212', alignItems: 'center', paddingHorizontal: 20 },
  header: { marginTop: 30, marginBottom: 40, alignItems: 'center', gap: 15 },
  title: { fontSize: 22, fontWeight: '500', color: '#E3E3E3', letterSpacing: 0.5 },
  headerBtns: { flexDirection: 'row', gap: 12 },
  iconBtn: { padding: 8, borderRadius: 20, backgroundColor: '#1E1E1E' },
  card: {
    backgroundColor: '#1E1E1E', padding: 28, borderRadius: 28,
    width: '100%', maxWidth: 400, elevation: 10,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 20, shadowOffset: { width: 0, height: 4 },
  },
  inputGroup: {
    backgroundColor: '#2D2D2D', borderRadius: 16, paddingHorizontal: 20, paddingVertical: 15,
    marginBottom: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 2, borderColor: 'transparent',
  },
  currencyLabel: { fontSize: 18, fontWeight: '700', color: '#C4C7C5', width: 40 },
  input: { flex: 1, color: '#E3E3E3', fontSize: 28, fontWeight: '400', textAlign: 'right', padding: 0 },
  pickerWrapper: { marginTop: 25, backgroundColor: '#252525', borderRadius: 20, overflow: 'hidden' },
  picker: { color: '#6DD58C', width: '100%' },
  loadingRow: { marginTop: 25, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  loadingText: { color: '#C4C7C5', fontSize: 14, textAlign: 'center', marginTop: 10 },
  offlineText: { color: '#888', fontSize: 12, textAlign: 'center', marginTop: 8 },
  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: '#1E1E1E', borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: 20, paddingTop: 20, paddingBottom: 40, maxHeight: '80%',
  },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  modalTitle: { color: '#E3E3E3', fontSize: 18, fontWeight: '600' },
  modalClose: { color: '#A8C7FA', fontSize: 15 },
  histRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#2D2D2D',
  },
  histDate: { color: '#C4C7C5', fontSize: 14, flex: 1 },
  histRate: { color: '#6DD58C', fontSize: 16, fontWeight: '600' },
});
