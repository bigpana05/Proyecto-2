import { Feather, FontAwesome5, MaterialCommunityIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
// 1. IMPORTAR NOTIFICACIONES
import * as Notifications from 'expo-notifications';

const STORAGE_KEY = '@server_ip';

// CONFIGURACIÓN DE UMBRALES
const THRESHOLD = {
    TEMP_WARN: 35,
    TEMP_CRIT: 50,
    GAS_WARN: 150,
    GAS_CRIT: 400,
    FIRE_PIXELS: 4000
};

// 2. CONFIGURAR COMPORTAMIENTO (Que suene aunque la app esté abierta)
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
    }),
});

export default function App() {
    // --- CONFIG ---
    const [serverIp, setServerIp] = useState('');
    const [showSettings, setShowSettings] = useState(false);
    const [tempIp, setTempIp] = useState('');
    const [isIpLoaded, setIsIpLoaded] = useState(false);

    // --- ESTADOS ---
    const [riskLevel, setRiskLevel] = useState(0); 
    const [riskMessage, setRiskMessage] = useState("Sistema estable");
    
    // Estado para el MODO DEMO (Simulación para el informe)
    const [demoMode, setDemoMode] = useState(false); 

    const [sensorData, setSensorData] = useState({
        temperatura: 0,
        humedad: 0,
        valorGas: 0,
        firePixels: 0
    });
    
    const [sprinklersActive, setSprinklersActive] = useState(false);
    const [connected, setConnected] = useState(false);
    
    const intervalRef = useRef(null);
    const lastCameraRequestRef = useRef(0);
    
    // 3. REFERENCIA PARA EL ANTI-SPAM DE NOTIFICACIONES
    const lastNotificationTime = useRef(0);

    // 4. PEDIR PERMISO DE NOTIFICACIONES AL INICIAR
    useEffect(() => {
        async function requestPermissions() {
            const { status } = await Notifications.requestPermissionsAsync();
            if (status !== 'granted') {
                Alert.alert('Permiso denegado', 'No podremos avisarte si hay fuego si no activas las notificaciones.');
            }
        }
        requestPermissions();
    }, []);

    // Cargar IP
    useEffect(() => {
        const loadIp = async () => {
            try {
                const savedIp = await AsyncStorage.getItem(STORAGE_KEY);
                if (savedIp) setServerIp(savedIp);
            } catch (e) { console.error(e); } 
            finally { setIsIpLoaded(true); }
        };
        loadIp();
    }, []);

    // Bucle de Datos (Lectura constante o SIMULACIÓN DEMO)
    useEffect(() => {
        // Si no hay IP y no estamos en modo demo, no hacemos nada
        if (!serverIp && !demoMode) return;

        const fetchData = async () => {
            
            // --- LOGICA DEL MODO DEMO ---
            if (demoMode) {
                // Generar datos falsos para las fotos del informe
                const randomChance = Math.random();
                // 40% de probabilidad de mostrar situación de PELIGRO
                const isDanger = randomChance > 0.6; 

                const fakeData = {
                    // Si es peligro, temp > 50, si no, temp ~20
                    temperatura: isDanger ? (52 + Math.random() * 10).toFixed(1) : (22 + Math.random() * 3).toFixed(1),
                    humedad: (30 + Math.random() * 15).toFixed(1),
                    // Si es peligro, gas > 400, si no, gas ~50
                    valorGas: isDanger ? (450 + Math.random() * 100).toFixed(0) : (40 + Math.random() * 20).toFixed(0),
                    // Si es peligro, muchos pixeles de fuego
                    firePixels: isDanger ? (4500 + Math.random() * 1000).toFixed(0) : 0
                };

                setSensorData({
                    temperatura: parseFloat(fakeData.temperatura),
                    humedad: parseFloat(fakeData.humedad),
                    valorGas: parseFloat(fakeData.valorGas),
                    firePixels: parseFloat(fakeData.firePixels)
                });

                setConnected(true); // Engañar a la UI para que diga "CONECTADO"
                return; // Salir aquí para no intentar conectar de verdad
            }
            // --- FIN LOGICA DEMO ---

            const now = Date.now();
            const shouldRequestCamera = (now - lastCameraRequestRef.current) > 0;

            let url = `http://${serverIp}:5000/datos`;
            if (shouldRequestCamera) {
                url += '?camara=1';
                lastCameraRequestRef.current = now;
            } else {
                url += '?camara=0';
            }

            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000);

                const response = await fetch(url, { signal: controller.signal });
                clearTimeout(timeoutId);

                if (response.ok) {
                    const json = await response.json();
                    const safeParse = (val) => (val === "Couldn't read" || val === undefined) ? 0 : parseFloat(val);

                    setSensorData(prev => ({
                        temperatura: safeParse(json.temperatura),
                        humedad: safeParse(json.humedad),
                        valorGas: safeParse(json.valorGas),
                        firePixels: shouldRequestCamera ? safeParse(json.firePixels) : prev.firePixels
                    }));

                    // Sincronizar estado real de aspersores desde el servidor
                    if (json.aspersores !== undefined) {
                        setSprinklersActive(json.aspersores);
                    }

                    setConnected(true);
                } else {
                    setConnected(false);
                }
            } catch (error) {
                setConnected(false);
            }
        };

        fetchData(); 
        intervalRef.current = setInterval(fetchData, 2000);
        return () => clearInterval(intervalRef.current);
    }, [serverIp, demoMode]); // Agregamos demoMode a dependencias

    // CEREBRO INTELIGENTE + NOTIFICACIONES
    useEffect(() => {
        if (!connected) return;

        const { firePixels, valorGas, temperatura } = sensorData;
        let score = 0;
        let reasons = [];

        if (temperatura > THRESHOLD.TEMP_CRIT) { score += 2; reasons.push("Calor Extremo"); } 
        else if (temperatura > THRESHOLD.TEMP_WARN) { score += 1; reasons.push("Alta Temperatura"); }

        if (valorGas > THRESHOLD.GAS_CRIT) { score += 2; reasons.push("Humo Denso"); } 
        else if (valorGas > THRESHOLD.GAS_WARN) { score += 1; reasons.push("Gases"); }

        if (firePixels > THRESHOLD.FIRE_PIXELS) { score += 3; reasons.push("Fuego Visible"); }

        // Determinar Nivel
        let currentLevel = 0;
        let message = "Ambiente Seguro";
        
        if (score >= 5) { currentLevel = 3; message = `PELIGRO: ${reasons.join(" + ")}`; } 
        else if (score >= 3) { currentLevel = 2; message = `Alerta: ${reasons.join(" y ")}`; } 
        else if (score >= 1) { currentLevel = 1; message = `Precaución: ${reasons[0]}`; }

        setRiskLevel(currentLevel);
        setRiskMessage(message);

        // 5. LÓGICA DE DISPARO DE NOTIFICACIÓN
        if (currentLevel >= 2) {
            sendEmergencyNotification(currentLevel, message);
        }

    }, [sensorData, connected]);

    // 6. FUNCIÓN PARA ENVIAR LA NOTIFICACIÓN
    const sendEmergencyNotification = async (level, bodyText) => {
        const now = Date.now();
        if (now - lastNotificationTime.current > 60000) {
            
            await Notifications.scheduleNotificationAsync({
                content: {
                    title: level === 3 ? "🚨 ¡PELIGRO - PYRO DETECTÓ FUEGO! 🚨" : "⚠️ Pyro: Advertencia del Sistema",
                    body: bodyText,
                    sound: true,
                    priority: Notifications.AndroidNotificationPriority.HIGH,
                    data: { data: 'goes here' },
                },
                trigger: null, // Enviar inmediatamente
            });

            lastNotificationTime.current = now;
        }
    };

    // --- LOGICA DEL BOTÓN DE ASPERSORES ---
    const toggleSprinklers = async () => {
        if (!connected) {
            Alert.alert("Pyro Offline", "Conecta el sistema primero");
            return;
        }

        const newState = !sprinklersActive;
        // Cambio optimista (UI instantánea)
        setSprinklersActive(newState); 

        // Si estamos en MODO DEMO, solo mostramos la alerta simulada
        if (demoMode) {
            Alert.alert("Modo Demo", newState ? "Aspersores ACTIVADOS (Simulado)" : "Aspersores APAGADOS (Simulado)");
            return;
        }

        try {
             const response = await fetch(`http://${serverIp}:5000/control_aspersores`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accion: newState }),
            });

            if (!response.ok) throw new Error("Error server");
            
        } catch (error) {
            console.error(error);
            // Revertir si falló
            setSprinklersActive(!newState);
            Alert.alert("Error", "No se pudo enviar la señal a Pyro Server");
        }
    };

    // --- UI ---
    const saveSettings = async () => {
        if(tempIp.length > 0) {
            setServerIp(tempIp);
            setConnected(false);
            await AsyncStorage.setItem(STORAGE_KEY, tempIp);
        }
        setShowSettings(false);
    };

    const getThemeColor = () => {
        if (!connected) return '#374151'; 
        switch(riskLevel) {
            case 3: return '#EF4444'; 
            case 2: return '#F97316'; 
            case 1: return '#EAB308'; 
            default: return '#1F2937'; 
        }
    };

    if (!isIpLoaded) return <View style={styles.loadingContainer}><ActivityIndicator size="large" color="#3B82F6" /></View>;

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: '#111827' }]}>
            <StatusBar barStyle="light-content" backgroundColor={getThemeColor()} />
            
            <View style={[styles.header, { backgroundColor: getThemeColor() }]}>
                <View style={styles.headerContent}>
                    <View style={styles.titleRow}>
                        {riskLevel >= 2 
                            ? <MaterialCommunityIcons name="fire-alert" size={28} color="white" />
                            : <MaterialCommunityIcons name="shield-check" size={28} color="white" />
                        }
                        <Text style={styles.headerTitle}>Pyro</Text>
                    </View>
                    <TouchableOpacity onPress={() => { setTempIp(serverIp); setShowSettings(true); }}>
                        <Feather name="settings" size={24} color="white" style={{ opacity: 0.9 }} />
                    </TouchableOpacity>
                </View>
                <View style={styles.statusBanner}>
                    <Text style={styles.statusText}>
                        {connected ? (demoMode ? "MODO DEMO ACTIVO" : riskMessage.toUpperCase()) : "SISTEMA DESCONECTADO"}
                    </Text>
                </View>
            </View>

            <ScrollView contentContainerStyle={styles.scrollContent}>
                
                <View style={styles.riskMeterContainer}>
                     <Text style={styles.sectionTitle}>NIVEL DE AMENAZA</Text>
                     <View style={styles.riskSteps}>
                         <View style={[styles.riskStep, riskLevel >= 0 ? {backgroundColor:'#22C55E'} : {}]} />
                         <View style={[styles.riskStep, riskLevel >= 1 ? {backgroundColor:'#EAB308'} : {}]} />
                         <View style={[styles.riskStep, riskLevel >= 2 ? {backgroundColor:'#F97316'} : {}]} />
                         <View style={[styles.riskStep, riskLevel >= 3 ? {backgroundColor:'#EF4444'} : {}]} />
                     </View>
                </View>

                <View style={styles.section}>
                    <View style={[styles.visualCard, riskLevel === 3 ? styles.visualCardDanger : {}]}>
                        <View style={styles.visualContent}>
                            <MaterialCommunityIcons 
                                name={sensorData.firePixels > 100 ? "fire" : "camera-iris"} 
                                size={40} 
                                color={sensorData.firePixels > 100 ? "#EF4444" : "#9CA3AF"} 
                            />
                            <View>
                                <Text style={styles.visualValue}>{connected ? sensorData.firePixels : "--"}</Text>
                                <Text style={styles.visualLabel}>PÍXELES DE FUEGO</Text>
                            </View>
                        </View>
                    </View>
                </View>

                <View style={styles.grid}>
                    <SensorCard 
                        icon="thermometer" title="Temp." 
                        value={connected ? sensorData.temperatura + "°C" : "--"} 
                        color="#FB923C" warning={sensorData.temperatura > THRESHOLD.TEMP_WARN}
                    />
                    <SensorCard 
                        icon="weather-windy" title="Gas" 
                        value={connected ? sensorData.valorGas : "--"} 
                        color="#9CA3AF" warning={sensorData.valorGas > THRESHOLD.GAS_WARN}
                    />
                    <SensorCard 
                        icon="water-percent" title="Humedad" 
                        value={connected ? sensorData.humedad + "%" : "--"} 
                        color="#60A5FA" 
                    />
                </View>

                <TouchableOpacity 
                    style={[
                        styles.actionButton, 
                        sprinklersActive ? styles.btnActive : styles.btnInactive,
                        !connected && { opacity: 0.5 },
                        riskLevel === 3 && !sprinklersActive && { borderColor: '#EF4444', borderWidth: 2 }
                    ]}
                    onPress={toggleSprinklers}
                    disabled={!connected}
                >
                    <FontAwesome5 name="faucet" size={24} color={sprinklersActive ? "white" : "#9CA3AF"} />
                    <Text style={[styles.btnText, sprinklersActive ? {color:'white'} : {color:'#9CA3AF'}]}>
                        {sprinklersActive ? 'DESACTIVAR SISTEMA' : 'ACTIVAR ASPERSORES'}
                    </Text>
                </TouchableOpacity>

            </ScrollView>

            <Modal visible={showSettings} animationType="slide" transparent={true}>
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <Text style={styles.modalTitle}>Configuración Pyro</Text>
                        
                        <Text style={{color:'#9CA3AF', marginBottom:5}}>Dirección IP Raspberry:</Text>
                        <TextInput 
                            style={styles.input}
                            value={tempIp}
                            onChangeText={setTempIp}
                            placeholder="Ej: 192.168.1.90"
                            placeholderTextColor="#6B7280"
                            keyboardType="numeric"
                        />

                        {/* --- BOTON MODO DEMO --- */}
                        <TouchableOpacity 
                            style={[styles.input, { 
                                backgroundColor: demoMode ? '#10B981' : '#374151', 
                                borderColor: demoMode ? '#10B981' : '#4B5563',
                                alignItems: 'center', 
                                justifyContent:'center' 
                            }]}
                            onPress={() => {
                                setDemoMode(!demoMode);
                                if(!demoMode) {
                                    Alert.alert("Modo Demo Activado", "Los datos mostrados son simulados para demostración.");
                                }
                                setShowSettings(false);
                            }}
                        >
                            <Text style={{color: 'white', fontWeight: 'bold'}}>
                                {demoMode ? "DESACTIVAR MODO DEMO" : "ACTIVAR SIMULACIÓN (DEMO)"}
                            </Text>
                        </TouchableOpacity>

                        <View style={styles.modalButtons}>
                            <TouchableOpacity onPress={() => setShowSettings(false)} style={styles.btnCancel}>
                                <Text style={styles.btnCancelText}>Cerrar</Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={saveSettings} style={styles.btnSave}>
                                <Text style={styles.btnSaveText}>Guardar IP</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>
        </SafeAreaView>
    );
}

const SensorCard = ({ icon, title, value, color, warning }) => (
    <View style={[styles.card, warning && { borderColor: color, borderWidth: 1, backgroundColor: color + '10' }]}>
        <View style={[styles.iconContainer, { backgroundColor: color + '20' }]}>
            <MaterialCommunityIcons name={icon} size={28} color={color} />
        </View>
        <View>
            <Text style={styles.cardLabel}>{title}</Text>
            <Text style={styles.cardValue}>{value}</Text>
        </View>
        {warning && <Feather name="alert-circle" size={16} color={color} style={{position:'absolute', top:10, right:10}} />}
    </View>
);

const styles = StyleSheet.create({
    loadingContainer: { flex: 1, backgroundColor: '#111827', justifyContent: 'center', alignItems: 'center' },
    container: { flex: 1 },
    header: { paddingTop: 50, paddingBottom: 20, borderBottomLeftRadius: 30, borderBottomRightRadius: 30, elevation: 8 },
    headerContent: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 25 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    headerTitle: { color: 'white', fontSize: 24, fontWeight: 'bold' },
    statusBanner: { marginTop: 15, backgroundColor: 'rgba(0,0,0,0.2)', marginHorizontal: 25, padding: 8, borderRadius: 12, alignItems: 'center' },
    statusText: { color: 'white', fontSize: 12, fontWeight: 'bold', letterSpacing: 1 },
    scrollContent: { padding: 25 },
    riskMeterContainer: { marginBottom: 20 },
    sectionTitle: { color:'#6B7280', fontSize:11, fontWeight:'bold', marginBottom:10, letterSpacing:1.5 },
    riskSteps: { flexDirection: 'row', gap: 5, height: 8 },
    riskStep: { flex: 1, backgroundColor: '#374151', borderRadius: 4 },
    visualCard: { backgroundColor: '#1F2937', padding: 15, borderRadius: 16, borderWidth: 1, borderColor: '#374151' },
    visualCardDanger: { borderColor: '#EF4444', backgroundColor: 'rgba(239, 68, 68, 0.1)' },
    visualContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    visualValue: { fontSize: 28, fontWeight: 'bold', color: 'white', fontFamily: 'monospace', textAlign: 'right' },
    visualLabel: { fontSize: 10, color: '#9CA3AF', fontWeight: 'bold', textAlign: 'right' },
    grid: { gap: 12, marginVertical: 20 },
    card: { backgroundColor: '#1F2937', padding: 16, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 16, borderLeftWidth: 4, borderLeftColor: '#374151' },
    iconContainer: { padding: 12, borderRadius: 12 },
    cardLabel: { color: '#9CA3AF', fontSize: 11, fontWeight: 'bold' },
    cardValue: { color: 'white', fontSize: 22, fontWeight: 'bold' },
    actionButton: { flexDirection: 'row', padding: 20, borderRadius: 16, justifyContent: 'center', alignItems: 'center', gap: 12 },
    btnActive: { backgroundColor: '#2563EB' },
    btnInactive: { backgroundColor: '#1F2937', borderWidth: 1, borderColor: '#374151' },
    btnText: { fontWeight: 'bold', fontSize: 16 },
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', padding: 20 },
    modalContent: { backgroundColor: '#1F2937', borderRadius: 20, padding: 25 },
    modalTitle: { color: 'white', fontSize: 20, fontWeight: 'bold', marginBottom: 20, textAlign: 'center' },
    input: { backgroundColor: '#111827', color: 'white', padding: 15, borderRadius: 10, marginBottom: 20, borderWidth: 1, borderColor: '#374151', fontSize: 16 },
    modalButtons: { flexDirection: 'row', gap: 15 },
    btnCancel: { flex: 1, padding: 15, borderRadius: 10, backgroundColor: '#374151', alignItems: 'center' },
    btnCancelText: { color: 'white' },
    btnSave: { flex: 1, padding: 15, borderRadius: 10, backgroundColor: '#2563EB', alignItems: 'center' },
    btnSaveText: { color: 'white', fontWeight: 'bold' },
});