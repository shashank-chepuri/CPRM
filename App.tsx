
// --- Part 1: Imports, Helpers, Context, Home Screen ---

// --- Part 1: Imports, Helpers, Context, Home Screen ---

import { Buffer } from 'buffer';
import React, { useEffect, useState, createContext, useContext, useRef } from 'react';
import {
  PermissionsAndroid,
  Platform,
  View,
  Text,
  NativeModules,
  Button,
  FlatList,
  Pressable,
  StyleSheet,
  Alert,
  Modal,
  TextInput,
  ScrollView
} from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import RNFS from 'react-native-fs';
import Share from 'react-native-share';
import { Image } from 'react-native';
import ReactNativeHapticFeedback from "react-native-haptic-feedback";
import Sound from 'react-native-sound';

const SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const CHARACTERISTIC_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

const bleManager = new BleManager();

// Initialize alarm sound
let alarmSound: any = null;

// Initialize the sound
Sound.setCategory('Playback');
alarmSound = new Sound('buzz.mp3', Sound.MAIN_BUNDLE, (error) => {
  if (error) {
    console.log('Failed to load the sound', error);
    return;
  }
  console.log('Alarm sound loaded successfully');
});

function getInterpolatedDose(cps: number, cpsToDoseMap: { cps: number; dose: number }[]): number {
  for (let i = 0; i < cpsToDoseMap.length - 1; i++) {
    const lower = cpsToDoseMap[i];
    const upper = cpsToDoseMap[i + 1];
    if (cps >= lower.cps && cps <= upper.cps) {
      const slope = (upper.dose - lower.dose) / (upper.cps - lower.cps);
      const interpolated = lower.dose + (cps - lower.cps) * slope;
      return interpolated;
    }
  }
  return cpsToDoseMap[cpsToDoseMap.length - 1].dose; // fallback to highest dose
}

function getTimeConstant(dose: number): { tc: number; updateInterval: number } {
  if (dose <= 100) return { tc: 8, updateInterval: 4 };
  if (dose <= 1000) return { tc: 4, updateInterval: 4 };
  return { tc: 2, updateInterval: 2 };
}

function formatDose(dose: number, unit: string, rawCps: number): string {
  if (unit === 'mR/h') {
    if (dose >= 100000) return `${(dose / 1000).toFixed(0)} R/h`;
    if (dose >= 10000) return `${(dose / 1000).toFixed(1)} R/h`;
    if (dose >= 1000) return `${(dose / 1000).toFixed(2)} R/h`;
    return `${dose.toFixed(2)} mR/h`;
  }

  if (unit === 'uSv/h') {
    const microsievert = dose * 10;
    if (microsievert >= 1000000) return `${(microsievert / 1000000).toFixed(2)} Sv/h`;
    if (microsievert >= 100000) return `${(microsievert / 1000).toFixed(0)} mSv/h`;
    if (microsievert >= 10000) return `${(microsievert / 1000).toFixed(1)} mSv/h`;
    if (microsievert >= 1000) return `${(microsievert / 1000).toFixed(2)} mSv/h`;
    return `${microsievert.toFixed(2)} µSv/h`;
  }

  if (unit === 'cGy/h') return `${(dose * 0.001).toFixed(4)} cGy/h`;
  if (unit === 'CPS') return `${rawCps} cps`;
  if (unit === 'CPM') return `${rawCps * 60} cpm`;
  return `${dose.toFixed(2)} mR/h`; // fallback
}

// --- Context Setup ---
type LogEntry = {
  rtc: string;
  cps: number;
  doseRate: number;
  cumDose: number;
  alert: string;
};

const checkStoragePermissions = async () => {
  if (Platform.OS !== 'android') return true;

  try {
    if (Platform.Version >= 29) {
      return true;
    }

    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
      {
        title: 'Storage Permission Required',
        message: 'This app needs storage access to export CSV files.',
        buttonNeutral: 'Ask Me Later',
        buttonNegative: 'Cancel',
        buttonPositive: 'OK',
      }
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  } catch (err) {
    console.warn('Permission error:', err);
    return false;
  }
};

const getAndroidFileUri = async (filePath: string) => {
  try {
    const fileUri = await NativeModules.FileProvider.getUriForFile(filePath);
    return fileUri;
  } catch (error) {
    console.warn('FileProvider error:', error);
    return 'file://' + filePath;
  }
};

type RadiationContextType = {
  radiationValue: string;
  setRadiationValue: React.Dispatch<React.SetStateAction<string>>;
  calibrationFactor: number;
  setCalibrationFactor: React.Dispatch<React.SetStateAction<number>>;
  alarmSetPoint: number;
  setAlarmSetPoint: React.Dispatch<React.SetStateAction<number>>;
  cumulativeDose: number;
  setCumulativeDose: React.Dispatch<React.SetStateAction<number>>;
  selectedUnit: string;
  setSelectedUnit: React.Dispatch<React.SetStateAction<string>>;
  logData: LogEntry[];
  setLogData: React.Dispatch<React.SetStateAction<LogEntry[]>>;
  autoManualMode: 'Auto' | 'Manual';
  setAutoManualMode: React.Dispatch<React.SetStateAction<'Auto' | 'Manual'>>;
  isManualDoseActive: boolean;
  setIsManualDoseActive: React.Dispatch<React.SetStateAction<boolean>>;
  bufferedDose: number;
  setBufferedDose: React.Dispatch<React.SetStateAction<number>>;
  cpsToDoseMap: { cps: number; dose: number }[];
  setCpsToDoseMap: React.Dispatch<React.SetStateAction<{ cps: number; dose: number }[]>>;
  isAlarmActive: boolean;
  setIsAlarmActive: React.Dispatch<React.SetStateAction<boolean>>;
  alarmSetPointOptions: number[];
};

const RadiationContext = createContext<RadiationContextType | null>(null);

const useRadiation = () => {
  const context = useContext(RadiationContext);
  if (!context) throw new Error('useRadiation must be used within RadiationProvider');
  return context;
};

const RadiationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [radiationValue, setRadiationValue] = useState('00000');
  const [calibrationFactor, setCalibrationFactor] = useState(1);
  const [alarmSetPoint, setAlarmSetPoint] = useState(1000);
  const [cumulativeDose, setCumulativeDose] = useState(0);
  const [selectedUnit, setSelectedUnit] = useState('mR/h');
  const [logData, setLogData] = useState<LogEntry[]>([]);
  const [autoManualMode, setAutoManualMode] = useState<'Auto' | 'Manual'>('Auto');
  const [isManualDoseActive, setIsManualDoseActive] = useState(false);
  const [bufferedDose, setBufferedDose] = useState(0);
  const [isAlarmActive, setIsAlarmActive] = useState(false);
  const alarmSetPointOptions = [5.0, 50.0, 100.0, 200.0];
  
  const [cpsToDoseMap, setCpsToDoseMap] = useState([
    { cps: 0, dose: 0 },
    { cps: 20, dose: 2 },
    { cps: 50, dose: 5 },
    { cps: 100, dose: 10 },
    { cps: 500, dose: 50 },
    { cps: 1000, dose: 100 },
    { cps: 4000, dose: 500 },
    { cps: 6800, dose: 1000 },
    { cps: 11000, dose: 2000 },
    { cps: 17500, dose: 5000 },
    { cps: 20500, dose: 8000 },
    { cps: 22500, dose: 10000 },
  ]);

  // Clean up sound on unmount
  useEffect(() => {
    return () => {
      if (alarmSound) {
        alarmSound.stop();
        alarmSound.release();
      }
    };
  }, []);

  return (
    <RadiationContext.Provider
      value={{
        radiationValue, setRadiationValue,
        calibrationFactor, setCalibrationFactor,
        alarmSetPoint, setAlarmSetPoint,
        cumulativeDose, setCumulativeDose,
        selectedUnit, setSelectedUnit,
        logData, setLogData,
        autoManualMode, setAutoManualMode,
        isManualDoseActive, setIsManualDoseActive,
        bufferedDose, setBufferedDose,
        cpsToDoseMap, setCpsToDoseMap,
        isAlarmActive, setIsAlarmActive,
        alarmSetPointOptions
      }}
    >
      {children}
    </RadiationContext.Provider>
  );
};

// --- Navigation Stack ---
type RootStackParamList = {
  Home: undefined;
  Radiation: undefined;
  Config: undefined;
  Templates: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

// --- Home Screen ---
const HomeScreen = ({ navigation }: { navigation: any }) => {
  const [isScanning, setIsScanning] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  const { setRadiationValue } = useRadiation();

  useEffect(() => {
    const requestPermissions = async () => {
      if (Platform.OS === 'android') {
        await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]);
      }
    };

    requestPermissions();

    return () => {
      bleManager.destroy();
    };
  }, []);

  const startScan = () => {
    setDevices([]);
    setIsScanning(true);

    const subscription = bleManager.onStateChange((state) => {
      if (state === 'PoweredOn') {
        bleManager.startDeviceScan(null, null, (error, device) => {
          if (error) {
            console.log('Scan error:', error);
            setIsScanning(false);
            return;
          }
          if (device?.name) {
            setDevices((prevDevices) => {
              if (prevDevices.find((d) => d.id === device.id)) return prevDevices;
              return [...prevDevices, device];
            });
          }
        });

        setTimeout(() => {
          bleManager.stopDeviceScan();
          setIsScanning(false);
        }, 5000);

        subscription.remove();
      } else {
        Alert.alert('Bluetooth Off', 'Please turn on Bluetooth.');
        setIsScanning(false);
      }
    }, true);
  };

  const connectToDevice = async (device: Device) => {
    try {
      await bleManager.stopDeviceScan();
      const connected = await device.connect();
      await connected.discoverAllServicesAndCharacteristics();

      let hasValidated = false;
      let validationTimeout: NodeJS.Timeout;

      connected.monitorCharacteristicForService(
        SERVICE_UUID,
        CHARACTERISTIC_UUID,
        (error, characteristic) => {
          if (error) {
            console.log('Notification error:', error);
            return;
          }

          if (characteristic?.value) {
            const decoded = Buffer.from(characteristic.value, 'base64').toString('utf-8');
            console.log('Raw BLE data:', decoded);

            const cpsMatch = decoded.match(/Cnts:(\d+)!/);
            if (cpsMatch) {
              const cps = cpsMatch[1];
              setRadiationValue(cps);

              if (!hasValidated) {
                hasValidated = true;
                clearTimeout(validationTimeout);
                setConnectedDevice(connected);
                navigation.navigate('Radiation');
              }
            }
          }
        }
      );

      validationTimeout = setTimeout(async () => {
        if (!hasValidated) {
          Alert.alert('Invalid Device', 'Please connect to a valid device.');
          await connected.cancelConnection();
        }
      }, 5000);

    } catch (error) {
      console.log('Connection error:', error);
      Alert.alert('Connection Failed', 'Could not connect to device');
    }
  };

  return (
    <View style={styles.container}>
      <Image source={require('./assets/logo.jpg')} style={styles.logo} />
      <Pressable
        onPress={startScan}
        disabled={isScanning}
        style={({ pressed }) => [
          {
            backgroundColor: isScanning ? '#666' : '#1E90FF',
            paddingVertical: 14,
            paddingHorizontal: 30,
            borderRadius: 10,
            alignItems: 'center',
            opacity: pressed ? 0.8 : 1,
            marginTop: 20,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.3,
            shadowRadius: 4,
            elevation: 5,
          }
        ]}
      >
        <Text style={{ color: 'white', fontSize: 18, fontWeight: 'bold' }}>
          {isScanning ? 'Scanning...' : 'Start Scan'}
        </Text>
      </Pressable>

      <FlatList
        style={styles.deviceList}
        data={devices}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={<Text style={styles.empty}>No Devices Found</Text>}
        renderItem={({ item }) => (
          <Pressable style={styles.deviceItem} onPress={() => connectToDevice(item)}>
            <Text style={styles.deviceText}>{item.name || 'Unnamed Device'}</Text>
            <Text style={styles.deviceTextSmall}>{item.id}</Text>
          </Pressable>
        )}
      />
      <View style={styles.connectedSection}>
        {connectedDevice && (
          <Text style={styles.status}>Connected to: {connectedDevice.name || connectedDevice.id}</Text>
        )}
        
        <Pressable
          onPress={() => {
            ReactNativeHapticFeedback.trigger("impactLight", {
              enableVibrateFallback: true,
              ignoreAndroidSystemSettings: false,
            });
            navigation.navigate('Radiation');
          }}
          android_ripple={{ color: '#333' }}
          style={({ pressed }) => [
            styles.radiationButton,
            pressed && { backgroundColor: '#444' },
          ]}
        >
          <Text style={styles.radiationButtonText}>Radiation Menu</Text>
        </Pressable>
      </View>
    </View>
  );
};

// --- Radiation Screen ---
const RadiationScreen = ({ navigation }: { navigation: any }) => {
  const {
    radiationValue,
    calibrationFactor,
    setCalibrationFactor,
    alarmSetPoint,
    setAlarmSetPoint,
    cumulativeDose,
    setCumulativeDose,
    selectedUnit,
    setSelectedUnit,
    logData,
    setLogData,
    autoManualMode,
    setAutoManualMode,
    isManualDoseActive,
    setIsManualDoseActive,
    bufferedDose,
    setBufferedDose,
    cpsToDoseMap,
    setCpsToDoseMap,
    isAlarmActive,
    setIsAlarmActive,
    alarmSetPointOptions
  } = useRadiation();

  const [cpsBuffer, setCpsBuffer] = useState<number[]>([]);
  const [interpolatedDose, setInterpolatedDose] = useState(0);
  const [manualButtonState, setManualButtonState] = useState<'start' | 'stop' | 'restart'>('start');
  const [displayDoseRate, setDisplayDoseRate] = useState(0);
  const [currentTc, setCurrentTc] = useState(0);
  const [blink, setBlink] = useState(false);

  // PRG & Menus
  const [showUnitSelect, setShowUnitSelect] = useState(false);
  const [unitOptions] = useState(["mR/h", "uSv/h", "cGy/h", "CPS", "CPM"]);
  const [unitIndex, setUnitIndex] = useState(0);
  const [unitVisibleStart, setUnitVisibleStart] = useState(0);

  const [showPrgMenu, setShowPrgMenu] = useState(false);
  const [selectedOption, setSelectedOption] = useState(0);
  const [visibleOptions, setVisibleOptions] = useState(4);

  const [showCumDoseReset, setShowCumDoseReset] = useState(false);
  const [cumDoseResetIndex, setCumDoseResetIndex] = useState(0);

  const [showCumDoseModeSelect, setShowCumDoseModeSelect] = useState(false);
  const [cumDoseModeIndex, setCumDoseModeIndex] = useState(0);

  const [showSaveConfirmation, setShowSaveConfirmation] = useState(false);

  // Calibration factor editing
  const [showCalibrationEdit, setShowCalibrationEdit] = useState(false);
  const [calibrationDigits, setCalibrationDigits] = useState<number[]>([1, 0, 0]);
  const [selectedDigitIndex, setSelectedDigitIndex] = useState(0);

  // Alarm set point editing
  const [showAlarmSetPoint, setShowAlarmSetPoint] = useState(false);
  const [alarmSetPointIndex, setAlarmSetPointIndex] = useState(0);
  const [alarmSetPointVisibleStart, setAlarmSetPointVisibleStart] = useState(0);

  // Lookup table
  const [showLookupTable, setShowLookupTable] = useState(false);
  const [lookupData, setLookupData] = useState<{ cps: number; dose: number }[]>([]);
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  const [editValue, setEditValue] = useState<string>('');

  // Temp values (only saved on "Save Parameters")
  const [tempUnit, setTempUnit] = useState(selectedUnit);
  const [tempAlarmSetPoint, setTempAlarmSetPoint] = useState(alarmSetPoint);
  const [tempCalibrationFactor, setTempCalibrationFactor] = useState(calibrationFactor);
  const [tempCumDoseMode, setTempCumDoseMode] = useState(autoManualMode);

  const PRG_OPTIONS = [
    "1. Rad Units",
    "2. Alarm Set Point",
    "3. Calibration Factor",
    "4. Cum Dose Reset",
    "5. Cum Dose Mode",
    "6. Read/Set Lookup Table",
    "7. Data Download",
    "8. Save Parameters"
  ];

  const lastUpdateRef = useRef(Date.now());
  const lastCumDoseUpdateRef = useRef(Date.now());

  // Initialize calibration digits when entering edit mode
  useEffect(() => {
    if (showCalibrationEdit) {
      const factorStr = tempCalibrationFactor.toFixed(2);
      const digits = factorStr.split('').filter(char => char !== '.').map(Number);
      setCalibrationDigits(digits);
      setSelectedDigitIndex(0);
    }
  }, [showCalibrationEdit, tempCalibrationFactor]);

  // Initialize lookup data with calibration table
  // Initialize lookup data with calibration table plus 2 empty rows
useEffect(() => {
  if (showLookupTable) {
    // Create a copy of the current mapping and add 2 empty rows at the end
    const extendedData = [...cpsToDoseMap];
    for (let i = 0; i < 2; i++) {
      extendedData.push({ cps: 0, dose: 0 });
    }
    setLookupData(extendedData);
  }
}, [showLookupTable, cpsToDoseMap]);

  // Alarm monitoring
  useEffect(() => {
    if (bufferedDose >= alarmSetPoint && !isAlarmActive) {
      // Trigger alarm
      setIsAlarmActive(true);
      if (alarmSound) {
        alarmSound.setNumberOfLoops(-1);
        alarmSound.play();
      }
      ReactNativeHapticFeedback.trigger("notificationError");
    } else if (bufferedDose < alarmSetPoint && isAlarmActive) {
      // Stop alarm
      setIsAlarmActive(false);
      if (alarmSound) {
        alarmSound.stop();
      }
    }
  }, [bufferedDose, alarmSetPoint, isAlarmActive]);

  // Blinking effect for alarm
  useEffect(() => {
    if (isAlarmActive) {
      const interval = setInterval(() => {
        setBlink(prev => !prev);
      }, 500);
      return () => clearInterval(interval);
    } else {
      setBlink(false);
    }
  }, [isAlarmActive]);

  const exportData = async (logData: any[]) => {
    try {
      if (Platform.OS === 'android') {
        const hasPermission = await checkStoragePermissions();
        if (!hasPermission) {
          Alert.alert('Permission Denied', 'Storage permission is required to export the file.');
          return;
        }
      }

      const header = 'RTC (YYYYMMDD,HHMMSS),CPS,Dose Rate (in mR/hr),Dose (in mR/hr),Radiation Alert\n';
      const rows = logData.map(e =>
        `${e.rtc},${e.cps},${e.doseRate.toFixed(2)},${e.cumDose.toFixed(2)},${e.alert}`
      );
      const csv = header + rows.join('\n');

      const path = `${RNFS.CachesDirectoryPath}/radiation_log_${Date.now()}.csv`;

      await RNFS.writeFile(path, csv, 'utf8');
      
      if (Platform.OS === 'android') {
        const fileUri = await getAndroidFileUri(path);
        await Share.open({ url: fileUri });
      } else {
        await Share.open({ url: 'file://' + path });
      }

    } catch (err) {
      console.error('Export error:', err);
      Alert.alert('Export Failed', 'Could not save or share the CSV file.');
    }
  };

  // Lookup table functions
  const handleLookupCellPress = (row: number, col: number) => {
    ReactNativeHapticFeedback.trigger("impactLight");
    setEditingCell({ row, col });
    if (col === 0) {
      setEditValue(lookupData[row].cps.toString());
    } else {
      setEditValue(lookupData[row].dose.toString());
    }
  };

  const handleLookupEditChange = (text: string) => {
    const numericValue = text.replace(/[^0-9]/g, '');
    setEditValue(numericValue);
  };

  const handleLookupEditComplete = () => {
    if (editingCell && editValue) {
      const newData = [...lookupData];
      const value = parseInt(editValue);
      
      if (!isNaN(value)) {
        if (editingCell.col === 0) {
          newData[editingCell.row].cps = value;
        } else {
          newData[editingCell.row].dose = value;
        }
        setLookupData(newData);
      }
    }
    setEditingCell(null);
    setEditValue('');
  };

 const handleSetLookupTable = () => {
  // Filter out empty rows but keep the first row (0, 0) even if it's (0, 0)
  const filteredData = lookupData.filter((item, index) => 
    index === 0 || item.cps !== 0 || item.dose !== 0
  );
  setCpsToDoseMap(filteredData);
  Alert.alert("Calibration Updated", "The new CPS to Dose mapping has been applied");
  setShowLookupTable(false);
  setShowPrgMenu(true);
};

  // Arrow Up
  const handleUpArrow = () => {
    ReactNativeHapticFeedback.trigger("impactLight");
    
    // Handle calibration digit editing
    if (showCalibrationEdit) {
      const newDigits = [...calibrationDigits];
      if (selectedDigitIndex === 0) {
        newDigits[selectedDigitIndex] = newDigits[selectedDigitIndex] === 1 ? 0 : 1;
      } else {
        newDigits[selectedDigitIndex] = (newDigits[selectedDigitIndex] + 1) % 10;
      }
      setCalibrationDigits(newDigits);
      return;
    }
    
    // Handle alarm set point selection
    if (showAlarmSetPoint) {
      const newIndex = alarmSetPointIndex > 0 ? alarmSetPointIndex - 1 : alarmSetPointOptions.length - 1;
      setAlarmSetPointIndex(newIndex);
      if (newIndex < alarmSetPointVisibleStart) setAlarmSetPointVisibleStart(Math.max(0, newIndex - 3));
      return;
    }
    
    if (showUnitSelect) {
      const newIndex = unitIndex > 0 ? unitIndex - 1 : unitOptions.length - 1;
      setUnitIndex(newIndex);
      if (newIndex < unitVisibleStart) setUnitVisibleStart(Math.max(0, newIndex - 3));
      else if (newIndex === unitOptions.length - 1) setUnitVisibleStart(Math.max(0, unitOptions.length - 4));
      return;
    }
    if (showCumDoseReset) { setCumDoseResetIndex(p => p > 0 ? p - 1 : 1); return; }
    if (showCumDoseModeSelect) { setCumDoseModeIndex(p => p > 0 ? p - 1 : 1); return; }

    let newSel = selectedOption > 0 ? selectedOption - 1 : 7;
    let newVis = visibleOptions;
    if (selectedOption === 0 && newSel === 7) newVis = 8;
    else if (newSel < visibleOptions - 4) newVis = Math.max(4, newSel + 1);
    setSelectedOption(newSel); setVisibleOptions(newVis);
  };

  // Arrow Down
  const handleDownArrow = () => {
    ReactNativeHapticFeedback.trigger("impactLight");
    
    // Handle calibration digit editing
    if (showCalibrationEdit) {
      const newDigits = [...calibrationDigits];
      if (selectedDigitIndex === 0) {
        newDigits[selectedDigitIndex] = newDigits[selectedDigitIndex] === 0 ? 1 : 0;
      } else {
        newDigits[selectedDigitIndex] = (newDigits[selectedDigitIndex] - 1 + 10) % 10;
      }
      setCalibrationDigits(newDigits);
      return;
    }
    
    // Handle alarm set point selection
    if (showAlarmSetPoint) {
      const newIndex = alarmSetPointIndex < alarmSetPointOptions.length - 1 ? alarmSetPointIndex + 1 : 0;
      setAlarmSetPointIndex(newIndex);
      if (newIndex >= alarmSetPointVisibleStart + 4) setAlarmSetPointVisibleStart(newIndex - 3);
      return;
    }
    
    if (showUnitSelect) {
      const newIndex = unitIndex < unitOptions.length - 1 ? unitIndex + 1 : 0;
      setUnitIndex(newIndex);
      if (newIndex >= unitVisibleStart + 4) setUnitVisibleStart(newIndex - 3);
      else if (newIndex === 0) setUnitVisibleStart(0);
      return;
    }
    if (showCumDoseReset) { setCumDoseResetIndex(p => p < 1 ? p + 1 : 0); return; }
    if (showCumDoseModeSelect) { setCumDoseModeIndex(p => p < 1 ? p + 1 : 0); return; }

    let newSel = selectedOption < 7 ? selectedOption + 1 : 0;
    let newVis = visibleOptions;
    if (selectedOption === 7 && newSel === 0) newVis = 4;
    else if (newSel >= visibleOptions) newVis = Math.min(8, newSel + 1);
    setSelectedOption(newSel); setVisibleOptions(newVis);
  };

  const handlePrgPress = () => {
    ReactNativeHapticFeedback.trigger("impactMedium");
    setShowPrgMenu(!showPrgMenu);
    if (!showPrgMenu) { setSelectedOption(0); setVisibleOptions(4); }
  };

 const handleEntSrtPress = () => {
  ReactNativeHapticFeedback.trigger("impactHeavy");

  // Handle calibration digit selection
  if (showCalibrationEdit) {
    if (selectedDigitIndex < 2) {
      setSelectedDigitIndex(selectedDigitIndex + 1);
    } else {
      setSelectedDigitIndex(0);
    }
    return;
  }

  // Menu selections
  if (showAlarmSetPoint) { 
    setTempAlarmSetPoint(alarmSetPointOptions[alarmSetPointIndex]); 
    setShowAlarmSetPoint(false); 
    setShowPrgMenu(true); 
    return; 
  }
  if (showUnitSelect) { 
    setTempUnit(unitOptions[unitIndex]); 
    setShowUnitSelect(false); 
    setShowPrgMenu(true); 
    return; 
  }
  if (showCumDoseReset) { 
    if (cumDoseResetIndex === 0) setCumulativeDose(0); 
    setShowCumDoseReset(false); 
    setShowPrgMenu(true); 
    return; 
  }
  if (showCumDoseModeSelect) { 
    setTempCumDoseMode(cumDoseModeIndex === 0 ? "Auto" : "Manual"); 
    setShowCumDoseModeSelect(false); 
    setShowPrgMenu(true); 
    return; 
  }
  if (showSaveConfirmation) { 
    setShowSaveConfirmation(false); 
    return; 
  }
  if (showLookupTable) return;

  // Manual Mode logic
  if (autoManualMode === 'Manual' && !showPrgMenu) {
    if (!isManualDoseActive) {
      if (manualButtonState === 'restart') {
        setCumulativeDose(0);
      }
      setIsManualDoseActive(true);
      setManualButtonState('stop');
    } else {
      setCumulativeDose(0);
      setIsManualDoseActive(true);
    }
    return;
  }

  // ✅ Allow ENT/SRT to work *only if PRG menu is open*
  if (showPrgMenu) {
    switch (selectedOption) {
      case 0:
        setShowUnitSelect(true);
        setShowPrgMenu(false);
        setUnitIndex(unitOptions.indexOf(tempUnit));
        break;
      case 1:
        setShowAlarmSetPoint(true);
        setShowPrgMenu(false);
        const closestIndex = alarmSetPointOptions.reduce(
          (prev, curr, index) =>
            Math.abs(curr - tempAlarmSetPoint) <
            Math.abs(alarmSetPointOptions[prev] - tempAlarmSetPoint)
              ? index
              : prev,
          0
        );
        setAlarmSetPointIndex(closestIndex);
        break;
      case 2:
        setShowCalibrationEdit(true);
        setShowPrgMenu(false);
        break;
      case 3:
        setShowCumDoseReset(true);
        setShowPrgMenu(false);
        break;
      case 4:
        setShowCumDoseModeSelect(true);
        setShowPrgMenu(false);
        setCumDoseModeIndex(tempCumDoseMode === 'Auto' ? 0 : 1);
        break;
      case 5:
        setShowLookupTable(true);
        setShowPrgMenu(false);
        break;
      case 6:
        exportData(logData);
        setShowPrgMenu(false);
        break;
      case 7:
        setSelectedUnit(tempUnit);
        setAlarmSetPoint(tempAlarmSetPoint);
        setCalibrationFactor(tempCalibrationFactor);
        setAutoManualMode(tempCumDoseMode);
        setShowPrgMenu(false);
        setShowSaveConfirmation(true);
        break;
      default:
        Alert.alert(PRG_OPTIONS[selectedOption], 'Not implemented.');
    }
  }

  // ❌ Do nothing if no menu and no manual logic
};


  const handleExtStpPress = () => {
    ReactNativeHapticFeedback.trigger("impactMedium");
    
    if (showCalibrationEdit) {
      const newValue = parseFloat(`${calibrationDigits[0]}.${calibrationDigits[1]}${calibrationDigits[2]}`);
      
      if (newValue < 0.75 || newValue > 1.25) {
        Alert.alert("Invalid Value", "Calibration factor must be between 0.75 and 1.25");
        return;
      }
      
      setTempCalibrationFactor(newValue);
      setShowCalibrationEdit(false);
      setShowPrgMenu(true);
      return;
    }
    
    if (showAlarmSetPoint) {
      setShowAlarmSetPoint(false);
      setShowPrgMenu(true);
      return;
    }
    
    if (showUnitSelect || showCumDoseReset || showCumDoseModeSelect) {
      setShowUnitSelect(false); 
      setShowCumDoseReset(false); 
      setShowCumDoseModeSelect(false); 
      setShowPrgMenu(true);
    } else if (showLookupTable) { 
      setShowLookupTable(false); 
      setShowPrgMenu(true); 
    } else if (showSaveConfirmation) { 
      setShowSaveConfirmation(false); 
    } else if (autoManualMode === 'Manual' && !showPrgMenu) { 
      setIsManualDoseActive(false); 
      setManualButtonState('restart'); 
    } else if (showPrgMenu) { 
      setShowPrgMenu(false); 
    }
  };

  // Dose calculation
  useEffect(() => {
    const cps = parseInt(radiationValue) || 0;
    const doseEstimate = getInterpolatedDose(cps, cpsToDoseMap);
    const { tc } = getTimeConstant(doseEstimate);
    setCurrentTc(tc);
    const newBuffer = [...cpsBuffer, cps].slice(-tc);
    const avgCps = newBuffer.reduce((a, b) => a + b, 0) / newBuffer.length;
    const dose = getInterpolatedDose(avgCps, cpsToDoseMap) * calibrationFactor;
    setCpsBuffer(newBuffer); 
    setBufferedDose(dose);
  }, [radiationValue, calibrationFactor, cpsToDoseMap]);

  // Display update
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const requiredInterval = bufferedDose <= 1000 ? 4000 : 2000;
      if (now - lastUpdateRef.current >= requiredInterval) { 
        setDisplayDoseRate(bufferedDose); 
        lastUpdateRef.current = now; 
      }
    }, 1000);
    return () => clearInterval(id);
  }, [bufferedDose]);

  // Cum dose logging
  useEffect(() => {
    const now = Date.now();
    if (now - lastCumDoseUpdateRef.current >= currentTc * 1000) {
      lastCumDoseUpdateRef.current = now;
      let inc = 0;
      if (autoManualMode === 'Auto' || isManualDoseActive) {
        inc = (bufferedDose / 3600) * currentTc;
        setCumulativeDose(prev => prev + inc);
      }
      const newCD = cumulativeDose + inc;
      const logNow = new Date();
      const rtc = `${logNow.getFullYear()}${String(logNow.getMonth() + 1).padStart(2, '0')}${String(logNow.getDate()).padStart(2, '0')},${String(logNow.getHours()).padStart(2, '0')}${String(logNow.getMinutes()).padStart(2, '0')}${String(logNow.getSeconds()).padStart(2, '0')}`;
      const entry = { rtc, cps: parseInt(radiationValue) || 0, doseRate: bufferedDose, cumDose: newCD, alert: bufferedDose >= alarmSetPoint ? 'ALARM' : 'NORMAL' };
      setLogData(prev => [...prev.slice(-999), entry]);
    }
    setInterpolatedDose(bufferedDose);
  }, [bufferedDose, currentTc, autoManualMode, isManualDoseActive, cumulativeDose, radiationValue, alarmSetPoint]);

  return (
    <View style={pixelPerfectStyles.container}>
      <View style={pixelPerfectStyles.header}><Image source={require('./assets/logo.jpg')} style={pixelPerfectStyles.logo} /></View>

      <View style={[pixelPerfectStyles.modeContainer, { height: 250 }]}>
        {showSaveConfirmation ? (
          <>
            <Text style={pixelPerfectStyles.modeText}>Save Parameters</Text>
            <Text style={pixelPerfectStyles.result}>Result: Saved</Text>
          </>
        ) : showCalibrationEdit ? (
          <>
            <Text style={pixelPerfectStyles.modeText}>Calibration Factor</Text>
            <View style={pixelPerfectStyles.calibrationContainer}>
              <Text style={pixelPerfectStyles.calibrationLabel}>Set Value:</Text>
              <View style={pixelPerfectStyles.calibrationDigits}>
                {calibrationDigits.map((digit, index) => (
                  <View key={index} style={pixelPerfectStyles.digitContainer}>
                    <Text style={[
                      pixelPerfectStyles.calibrationDigit,
                      index === selectedDigitIndex && pixelPerfectStyles.selectedDigit
                    ]}>
                      {digit}
                    </Text>
                    {index === 0 && <Text style={pixelPerfectStyles.decimalPoint}>.</Text>}
                  </View>
                ))}
              </View>
              <Text style={pixelPerfectStyles.calibrationHelp}>
                Use ▲/▼ to change, ENT to select next digit
              </Text>
            </View>
          </>
        ) : showAlarmSetPoint ? (
          <>
            <Text style={pixelPerfectStyles.modeText}>Alarm Set Point:</Text>
            {alarmSetPointOptions.slice(alarmSetPointVisibleStart, alarmSetPointVisibleStart + 4).map((value, i) => {
              const actualIndex = alarmSetPointVisibleStart + i;
              const isSelected = actualIndex === alarmSetPointIndex;
              return (
                <View key={value} style={pixelPerfectStyles.menuRow}>
                  <Text style={[pixelPerfectStyles.menuItem, isSelected && pixelPerfectStyles.selectedMenuItem]}>
                    {value.toFixed(1)} mR/h
                  </Text>
                  {isSelected && <Text style={pixelPerfectStyles.selectorIcon}>◀</Text>}
                </View>
              );
            })}
          </>
        ) : showLookupTable ? (
          <>
            <Text style={pixelPerfectStyles.modeText}>CPS vs Dose Calibration Table</Text>
            <View style={pixelPerfectStyles.lookupContainer}>
              <View style={pixelPerfectStyles.lookupHeader}>
                <Text style={pixelPerfectStyles.lookupHeaderText}>CPS</Text>
                <Text style={pixelPerfectStyles.lookupHeaderText}>Dose (mR/h)</Text>
              </View>
              <ScrollView style={pixelPerfectStyles.lookupScroll}>
                {lookupData.map((item, index) => (
  <View key={index} style={pixelPerfectStyles.lookupRow}>
    {editingCell?.row === index && editingCell.col === 0 ? (
      <TextInput
        style={pixelPerfectStyles.lookupInput}
        value={editValue}
        onChangeText={handleLookupEditChange}
        onBlur={handleLookupEditComplete}
        keyboardType="numeric"
        autoFocus
      />
    ) : (
      <Pressable 
        style={pixelPerfectStyles.lookupCell}
        onPress={() => handleLookupCellPress(index, 0)}
      >
        <Text style={[
          pixelPerfectStyles.lookupCellText,
          item.cps === 0 && index > 0 && pixelPerfectStyles.placeholderText
        ]}>
          {item.cps !== 0 || index === 0 ? item.cps : "Tap to add"}
        </Text>
      </Pressable>
    )}
    
    {editingCell?.row === index && editingCell.col === 1 ? (
      <TextInput
        style={pixelPerfectStyles.lookupInput}
        value={editValue}
        onChangeText={handleLookupEditChange}
        onBlur={handleLookupEditComplete}
        keyboardType="numeric"
        autoFocus
      />
    ) : (
      <Pressable 
        style={pixelPerfectStyles.lookupCell}
        onPress={() => handleLookupCellPress(index, 1)}
      >
        <Text style={[
          pixelPerfectStyles.lookupCellText,
          item.dose === 0 && index > 0 && pixelPerfectStyles.placeholderText
        ]}>
          {item.dose !== 0 || index === 0 ? item.dose : "Tap to add"}
        </Text>
      </Pressable>
    )}
  </View>
))}
              </ScrollView>
              <Pressable 
                style={pixelPerfectStyles.setButton}
                onPress={handleSetLookupTable}
              >
                <Text style={pixelPerfectStyles.setButtonText}>SET CALIBRATION</Text>
              </Pressable>
            </View>
          </>
        ) : showUnitSelect ? (
          <>
            <Text style={pixelPerfectStyles.modeText}>Select Unit:</Text>
            {unitOptions.slice(unitVisibleStart, unitVisibleStart + 4).map((unit, i) => {
              const actualIndex = unitVisibleStart + i;
              const isSelected = actualIndex === unitIndex;
              return (
                <View key={unit} style={pixelPerfectStyles.menuRow}>
                  <Text style={[pixelPerfectStyles.menuItem, isSelected && pixelPerfectStyles.selectedMenuItem]}>{unit}</Text>
                  {isSelected && <Text style={pixelPerfectStyles.selectorIcon}>◀</Text>}
                </View>
              );
            })}
          </>
        ) : showCumDoseReset ? (
          <>
            <Text style={pixelPerfectStyles.modeText}>Reset Cumulative Dose?</Text>
            {["Yes", "No"].map((opt, i) => (
              <View key={opt} style={pixelPerfectStyles.menuRow}>
                <Text style={[pixelPerfectStyles.menuItem, i === cumDoseResetIndex && pixelPerfectStyles.selectedMenuItem]}>{opt}</Text>
                {i === cumDoseResetIndex && <Text style={pixelPerfectStyles.selectorIcon}>◀</Text>}
              </View>
            ))}
          </>
        ) : showCumDoseModeSelect ? (
          <>
            <Text style={pixelPerfectStyles.modeText}>Select Cum Dose Mode:</Text>
            {["Auto", "Manual"].map((opt, i) => (
              <View key={opt} style={pixelPerfectStyles.menuRow}>
                <Text style={[pixelPerfectStyles.menuItem, i === cumDoseModeIndex && pixelPerfectStyles.selectedMenuItem]}>{opt}</Text>
                {i === cumDoseModeIndex && <Text style={pixelPerfectStyles.selectorIcon}>◀</Text>}
              </View>
            ))}
          </>
        ) : showPrgMenu ? (
          <>
            {PRG_OPTIONS.slice(visibleOptions - 4, visibleOptions).map((option, index) => {
              const optionIndex = visibleOptions - 4 + index;
              const isSelected = optionIndex === selectedOption;
              return (
                <View key={optionIndex} style={pixelPerfectStyles.menuRow}>
                  <Text style={[pixelPerfectStyles.menuItem, isSelected && pixelPerfectStyles.selectedMenuItem]}>{option}</Text>
                  {isSelected && <Text style={pixelPerfectStyles.selectorIcon}> ◀</Text>}
                </View>
              );
            })}
          </>
        ) : (
          <>
            <Text style={pixelPerfectStyles.modeText}>Cum Dose Mode: {autoManualMode}</Text>
            {/* Alarm status */}
              <Text style={[
                pixelPerfectStyles.modeText,
                isAlarmActive && pixelPerfectStyles.modeText,
                blink && { opacity: 0.5 }
              ]}>
                {isAlarmActive ? 'ALARM!' : 'NORMAL'}
              </Text>
            <View style={pixelPerfectStyles.doseDisplay}>
              <Text style={pixelPerfectStyles.doseRate}>{formatDose(displayDoseRate, selectedUnit, parseInt(radiationValue))}</Text>
              <Text style={pixelPerfectStyles.cumulativeDose}>{formatDose(cumulativeDose, selectedUnit, parseInt(radiationValue)).replace(/\/h$/, '')}</Text>
              
            </View>
          </>
        )}
      </View>

      <View style={pixelPerfectStyles.divider} />
      <View style={pixelPerfectStyles.buttonGrid}>
        <View style={pixelPerfectStyles.buttonRow}>
          <View style={pixelPerfectStyles.buttonColumn}>
            <Pressable style={pixelPerfectStyles.button} onPress={handleEntSrtPress}><Text style={pixelPerfectStyles.buttonText}>ENT/SRT</Text></Pressable>
            <View style={pixelPerfectStyles.buttonSpacer} />
            <Pressable style={pixelPerfectStyles.button} onPress={handleExtStpPress}><Text style={pixelPerfectStyles.buttonText}>EXT/STP</Text></Pressable>
          </View>
          <View style={pixelPerfectStyles.buttonColumn}>
            <View style={pixelPerfectStyles.buttonSpacer} />
            <Pressable style={[pixelPerfectStyles.button, showPrgMenu && pixelPerfectStyles.activePrgButton]} onPress={handlePrgPress}><Text style={pixelPerfectStyles.buttonText}>PRG</Text></Pressable>
          </View>
          <View style={pixelPerfectStyles.buttonColumn}>
            <Pressable style={pixelPerfectStyles.button} onPress={handleUpArrow}><Text style={pixelPerfectStyles.buttonText}>▲</Text></Pressable>
            <View style={pixelPerfectStyles.buttonSpacer} />
            <Pressable style={pixelPerfectStyles.button} onPress={handleDownArrow}><Text style={pixelPerfectStyles.buttonText}>▼</Text></Pressable>
          </View>
        </View>
      </View>
    </View>
  );
};

// --- App Wrapper ---
const App = () => {
  return (
    <RadiationProvider>
      <NavigationContainer>
        <Stack.Navigator
          initialRouteName="Home"
          screenOptions={{
            headerStyle: { backgroundColor: '#0571deff' },
            headerTintColor: '#ffffffff',
            headerTitleStyle: { fontWeight: 'bold' },
            headerTitleAlign:'center'
          }}
        >
          <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'RADIATION MONITOR' }} />
          <Stack.Screen name="Radiation" component={RadiationScreen} options={{ title: 'RADIATION MONITOR' }} />
        </Stack.Navigator>
      </NavigationContainer>
    </RadiationProvider>
  );
};

// --- Styles ---
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#acdbedff',
    padding: 20,
    paddingTop: 50,
  },
  title: {
    fontSize: 24,
    color: '#00FFAA',
    marginBottom: 20,
    textAlign: 'center',
    fontWeight: '700',
  },
  deviceList: {
    marginTop: 15,
    marginBottom: 30,

  },
  empty: {
    marginTop: 30,
    color: '#4d3e3eff',
    textAlign: 'center',
    fontSize:16
  },
  deviceItem: {
    backgroundColor: '#0571deff',
    padding: 15,
    borderRadius: 8,
    marginVertical: 6,
   
  },
  deviceText: {
    color: '#fff',
    fontSize: 16,
  },
  deviceTextSmall: {
    color: '#aaa',
    fontSize: 12,
  },
  connectedSection: {
    marginTop: 10,
    paddingVertical: 15,
    borderTopWidth: 1,
    borderTopColor: '#444',
    alignItems: 'center',
  },
  status: {
    color: '#00FFAA',
    fontSize: 16,
    fontWeight: '600',
  },
  radiationButton: {
    marginTop: 10,
    backgroundColor: '#0571deff',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    width: '100%', 
  },

  Config_menuButton: {
    marginTop: 30,
    backgroundColor: '#2E2E2E',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    width: '100%', 
  },
  radiationButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  radiationScreenContainer: {
    flex: 1,
    backgroundColor: '#121212',
    padding: 30,
    justifyContent: 'flex-start',
  },
  radiationScreenTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    textAlign: 'center',
    color: '#ffffff',
    marginBottom: 30,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 8,
    backgroundColor: '#1D1D1D',
    padding: 10,
    borderRadius: 10,
  },
  label: {
    color: '#ccc',
    fontSize: 16,
    width: 110,
  },
  colon: {
    color: '#ccc',
    fontSize: 16,
    marginHorizontal: 5,
  },
  value: {
    color: '#00FFAA',
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
    textAlign: 'left',
  },
  inputField: {
    backgroundColor: '#1E1E1E',
    color: '#00FFAA',
    padding: 8,
    borderRadius: 6,
    fontSize: 16,
    flex: 1,
  },

  logo: {
  width: 120,        // You can adjust size here
  height: 120,
  resizeMode: 'contain',
  alignSelf: 'center',
  marginBottom: 30,
},

smallButton: {
  height: 38,
  justifyContent: 'center',
  paddingHorizontal: 20,
  paddingVertical: 0,
  marginBottom: 0,
  marginTop: 0,
  backgroundColor: '#2E2E2E',
  borderRadius: 12,
  alignSelf: 'flex-start', // Optional: controls alignment
},


smallButtonText: {
  color: '#fff',
  fontSize: 14,
  fontWeight: '500',
  textAlign: 'center',
},

startStopButtonText: {
  color: '#fff',
  fontSize: 15,
  fontWeight: '600',
  textAlign: 'center',
  
},

startStopButton: {
  paddingVertical: 12,
  paddingHorizontal: 25,
  borderRadius: 12,
  marginHorizontal: 10,
  minWidth: 120,
  alignItems: 'center',
},

});



const pixelPerfectStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#acdbedff',
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignSelf: 'center',
    marginBottom: 10,
  },
  title: {
    color: '#FFF',
    fontSize: 20,
    fontWeight: 'bold',
    textAlign: 'center',
    flex: 1,
  },
  logo: {
    width: 80,
    height: 80,
    resizeMode: 'contain',
   
  },
 modeContainer: {
    backgroundColor: '#ffffff',
    paddingHorizontal: 6,  // Reduced from 10
    paddingVertical: 2,    // Very tight vertical padding
          // Space below header
    //alignSelf: 'flex-start', // Hug content width
    borderRadius: 2,      // Subtle rounding
    width:'85%',
    alignSelf: 'center',
    marginBottom:'10%',
    borderWidth: 4,
    borderColor:'#0571deff'

  },
  modeText: {
    color: 'black',
    fontSize: 22,
    marginTop:'3%', 
    fontWeight: 'bold',

  },
  doseDisplay: {
    marginTop:'20%',
    marginBottom: 20,
  },
  doseRate: {
     color:'black',
    fontSize: 30,
    fontWeight: 'bold',
    marginBottom: 15,
  },
  cumulativeDose: {
    color:'black',
    fontSize: 28,
    fontWeight: 'bold',
  },
  divider: {
    height: 1,
    backgroundColor: '#333',
    marginBottom: 20,
  },
  buttonGrid: {
    marginTop: 20,
    alignSelf: 'center',
    borderWidth:4,
    borderRadius:20,
    
    
    
  },
  buttonRow: {
    flexDirection: 'row',
    margin:'4%',
    marginTop:'6%',
    marginBottom:'6%'
    
  },
  buttonColumn: {
    width:80,
    margin:10,
    alignSelf:'center'

    
  },
  button: {
    backgroundColor: '#0571deff',
    paddingVertical: 12,
    borderRadius: 5,
    alignItems: 'center',
    marginBottom: 10,
    
   
  },
  buttonText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
  buttonSpacer: {
    height: 10,
    
    
  },
  checkmarkBox: {
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkmark: {
    color: '#0F0',
    fontSize: 24,
  },

   menuRow: {
    flexDirection: 'row',
    
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    
    height:53.25,
    paddingHorizontal: 10,
  },
  menuItem: {
    color: 'black',
    fontSize: 21,
    marginVertical: 4,
    fontWeight: '500',
   // maxWidth:'100%'
  },
  selectorIcon: {
    color: '#0571deff',
    fontSize: 18,
    fontWeight: 'bold',
  },
   selectedMenuItem: {
    color: '#0571deff',
    fontWeight: 'bold',
  },

 
  activePrgButton: {
    backgroundColor: '#045cb3', // Slightly darker blue when active
  },



 result: {
    color: 'black',
    fontSize: 21,
    marginVertical: 40,
    fontWeight: '500',
   // maxWidth:'100%'
  },




  
  calibrationContainer: {
  alignItems: 'center',
  marginTop: 10,
},
calibrationLabel: {
  color: 'black',
  fontSize: 18,
  marginBottom: 10,
},
calibrationDigits: {
  flexDirection: 'row',
  alignItems: 'center',
  marginBottom: 10,
},
digitContainer: {
  flexDirection: 'row',
  alignItems: 'center',
},
calibrationDigit: {
  color: 'black',
  fontSize: 24,
  fontWeight: 'normal',
  width: 20,
  textAlign: 'center',
},
selectedDigit: {
  backgroundColor: '#0571deff',
  color: 'white',
  borderRadius: 3,
},
decimalPoint: {
  color: 'black',
  fontSize: 24,
  marginHorizontal: 2,
},
calibrationHelp: {
  color: 'black',
  fontSize: 14,
  fontStyle: 'italic',
},

lookupContainer: {
  flex: 1,
  width: '100%',
},
lookupSubtitle: {
  color: 'black',
  fontSize: 4,
  marginBottom: 10,
  textAlign: 'center',
},
lookupHeader: {
  flexDirection: 'row',
  justifyContent: 'space-between',
  paddingVertical: 10,
  borderBottomWidth: 2,
  borderBottomColor: '#0571deff',
},
lookupHeaderText: {
  color: 'black',
  fontSize: 16,
  fontWeight: 'bold',
  flex: 1,
  textAlign: 'center',
},
lookupScroll: {
  maxHeight: 150,
  marginVertical: 10,
},
lookupRow: {
  flexDirection: 'row',
  justifyContent: 'space-between',
  paddingVertical: 8,
  borderBottomWidth: 1,
  borderBottomColor: '#ccc',
},
lookupCell: {
  flex: 1,
  padding: 5,
  alignItems: 'center',
},
lookupCellText: {
  color: 'black',
  fontSize: 14,
},
lookupInput: {
  flex: 1,
  borderWidth: 1,
  borderColor: '#0571deff',
  backgroundColor: 'white',
  color: 'black',
  padding: 5,
  textAlign: 'center',
  fontSize: 14,
},
setButton: {
  backgroundColor: '#0571deff',
  padding: 10,
  borderRadius: 5,
  alignItems: 'center',
  marginTop: 10,
},
setButtonText: {
  color: 'white',
  fontSize: 16,
  fontWeight: 'bold',
},
placeholderText: {
  color: '#999',
  fontStyle: 'italic',
},

});

export default App;
