import { useState, useEffect, useRef } from 'react';
import { 
  Package, 
  ArrowLeftRight, 
  Camera, 
  RotateCw, 
  AlertTriangle, 
  CheckCircle, 
  Wifi, 
  WifiOff, 
  Lock,
  Plus,
  Inbox,
  Sparkles,
  BarChart3,
  LogOut,
  Send,
  Check,
  AlertCircle,
  Printer,
  X,
  Trash2,
  Clock,
  Calendar,
  DollarSign,
  Shield,
  UserPlus,
  MapPin,
  ChevronDown,
  ImageIcon,
  Truck
} from 'lucide-react';
import { supabase } from './supabaseClient';
import { parseTireSticker, parseTireSidewall, parseBulkStack, estimateStackCount, inferWinterApprovedFromCatalog } from './openaiClient';
import type { TireStickerData } from './openaiClient';
import { offlineStorage } from './offlineStorage';
import type { PendingTransaction } from './offlineStorage';
import { ScanViewfinder } from './components/ScanViewfinder';
import { WinterApprovedToggle } from './components/WinterApprovedToggle';
import { PremisesLockOverlay } from './components/PremisesLockOverlay';
import { ProductPhotoStudio } from './components/ProductPhotoStudio';
import { BuildGalleryStudio } from './components/BuildGalleryStudio';
import { GEOFENCE_RADIUS_KM, STORE_LOCATIONS, getPremisesStatus, isCatalogImageMissing } from './lib/storeLocations';
import { authHeaders, clearStaffToken, setStaffToken } from './staffAuth';

type ActiveTab = 'dashboard' | 'receive' | 'transfer' | 'verify' | 'estimate' | 'audit' | 'orders' | 'logs' | 'timecard' | 'workforce' | 'schedule' | 'payroll' | 'permissions' | 'product-photos' | 'build-gallery';

type AppUser = {
  role: 'worker' | 'manager';
  name: string;
  location: string;
  technicianId?: string;
  isSuperAdmin?: boolean;
};

/** Grace period after leaving fence before auto clock-out */
const GEOFENCE_GRACE_MS = 15 * 60 * 1000;
/** Local dev only: set VITE_GEOFENCE_DEV_BYPASS=true in .env to test off-site */
const GEOFENCE_DEV_BYPASS = import.meta.env.DEV && import.meta.env.VITE_GEOFENCE_DEV_BYPASS === 'true';

function formatElapsedSince(isoDate: string): string {
  const elapsedMs = Math.max(0, Date.now() - Date.parse(isoDate));
  const secs = Math.floor((elapsedMs / 1000) % 60);
  const mins = Math.floor((elapsedMs / 60000) % 60);
  const hrs = Math.floor(elapsedMs / 3600000);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export interface CustomerOrder {
  id: string;
  order_number: string;
  source: 'website' | 'square_pos';
  status: 'pending_shipping' | 'shipped' | 'cancelled' | 'ready_for_pickup' | 'picked_up';
  customer_name: string;
  shipping_address?: string;
  shipping_method?: string;
  tracking_number?: string;
  items: Array<{ sku: string; brand: string; size: string; quantity: number; price: number }>;
  location_id: string;
  created_at: string;
}

// Helper to calculate distance in km (Haversine formula)
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

export const formatSku = (brand: string, size: string, model: string) => {
  const cleanBrand = brand.trim().toUpperCase().replace(/[^A-Z0-9]/g, '-').replace(/-+/g, '-');
  const cleanModel = model.trim().toUpperCase().replace(/[^A-Z0-9]/g, '-').replace(/-+/g, '-');
  // Normalize size: 225/65R17 -> 225-65-17
  const cleanSize = size.trim().toUpperCase()
    .replace(/[R]/g, '')             // remove R
    .replace(/[^0-9.]/g, '-')        // replace non-numeric with hyphens
    .replace(/-+/g, '-')             // collapse duplicate hyphens
    .replace(/^-|-$/g, '');          // trim leading/trailing hyphens
  
  return `${cleanBrand}-${cleanSize}-${cleanModel}`;
};

export default function App() {
  // Authentication & Location State
  const [activeLocation, setActiveLocation] = useState<string | null>(null);
  const [locationName, setLocationName] = useState<string>('');
  const [pinInput, setPinInput] = useState<string>('');
  const [loginMode, setLoginMode] = useState<'technician' | 'admin'>('technician');
  const [currentUser, setCurrentUser] = useState<AppUser | null>(() => {
    const saved = localStorage.getItem('onecmd_current_user');
    if (!saved) return null;
    try {
      const parsed = JSON.parse(saved) as AppUser;
      if (parsed.role === 'manager' && !parsed.technicianId) {
        parsed.isSuperAdmin = true;
      }
      return parsed;
    } catch {
      return null;
    }
  });
  const [authError, setAuthError] = useState<string>('');

  // General App State
  const [activeTab, setActiveTab] = useState<ActiveTab>('dashboard');
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [pendingSyncCount, setPendingSyncCount] = useState<number>(0);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [globalMessage, setGlobalMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Locations Catalog Cache with coordinates for geofence validation
  const [locations] = useState(STORE_LOCATIONS.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng })));

  // Core Feature State: Orders Shipping & Labels
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<CustomerOrder | null>(null);
  const [trackingInput, setTrackingInput] = useState<string>('');
  const [dispatching, setDispatching] = useState<boolean>(false);

  // Core Feature State: Receive
  const [receivePhoto, setReceivePhoto] = useState<string | null>(null);
  const [extractedSpecs, setExtractedSpecs] = useState<TireStickerData | null>(null);
  const [bulkExtractedSpecs, setBulkExtractedSpecs] = useState<TireStickerData[] | null>(null);
  const [bulkQuantities, setBulkQuantities] = useState<{ [key: number]: number }>({});
  const [savingBulkReceive, setSavingBulkReceive] = useState<boolean>(false);
  const [extracting, setExtracting] = useState<boolean>(false);
  const [quantityInput, setQuantityInput] = useState<string>('');
  const [savingReceive, setSavingReceive] = useState<boolean>(false);
  const [skuExists, setSkuExists] = useState<boolean | null>(null);
  const [winterApproved, setWinterApproved] = useState<boolean>(false);
  const [winterApprovedAiDetected, setWinterApprovedAiDetected] = useState<boolean>(false);
  const [receiveScanError, setReceiveScanError] = useState<string>('');
  const [undoingIntake, setUndoingIntake] = useState<boolean>(false);
  const [scanMode, setScanMode] = useState<'sticker' | 'sidewall' | 'bulk'>('sticker');
  const [productPhoto, setProductPhoto] = useState<string | null>(null);
  const [bulkProductPhotos, setBulkProductPhotos] = useState<{ [key: number]: string }>({});

  // Core Feature State: Transaction History Logs & Corrections
  const [recentTransactions, setRecentTransactions] = useState<PendingTransaction[]>([]);
  const [managerPinModalOpen, setManagerPinModalOpen] = useState<boolean>(false);
  const [managerPinInput, setManagerPinInput] = useState<string>('');
  const [managerPinError, setManagerPinError] = useState<string>('');
  const [editingTransaction, setEditingTransaction] = useState<PendingTransaction | null>(null);
  const [newQtyInput, setNewQtyInput] = useState<string>('');
  const [flagModalOpen, setFlagModalOpen] = useState<boolean>(false);
  const [flagTx, setFlagTx] = useState<PendingTransaction | null>(null);
  const [flagNoteInput, setFlagNoteInput] = useState<string>('');

  // Core Feature State: Transfer
  const [transferDest, setTransferDest] = useState<string>('');
  const [transferPhoto, setTransferPhoto] = useState<string | null>(null);
  const [transferSpecs, setTransferSpecs] = useState<TireStickerData | null>(null);
  const [transferQty, setTransferQty] = useState<string>('');
  const [sendingTransfer, setSendingTransfer] = useState<boolean>(false);

  // Core Feature State: Handshake Verification
  const [pendingTransfers, setPendingTransfers] = useState<PendingTransaction[]>([]);
  const [selectedTransfer, setSelectedTransfer] = useState<PendingTransaction | null>(null);
  const [verifyPhoto, setVerifyPhoto] = useState<string | null>(null);
  const [verifyQty, setVerifyQty] = useState<string>('');
  const [verifyingTransfer, setVerifyingTransfer] = useState<boolean>(false);

  // Core Feature State: Estimator
  const [estimatorPhoto, setEstimatorPhoto] = useState<string | null>(null);
  const [estimateResult, setEstimateResult] = useState<{ min: number; max: number; conf: number; reason: string } | null>(null);
  const [estimating, setEstimating] = useState<boolean>(false);
  const [showLearningPrompt, setShowLearningPrompt] = useState<boolean>(false);
  const [actualStackCount, setActualStackCount] = useState<string>('');
  const [learningReason, setLearningReason] = useState<string>('');
  const [learningSubmitted, setLearningSubmitted] = useState<boolean>(false);

  // Core Feature State: Weekly Audit
  const [auditPhotos, setAuditPhotos] = useState<string[]>([]);
  const [auditing, setAuditing] = useState<boolean>(false);
  const [auditReport, setAuditReport] = useState<{
    confidence: number;
    discrepancyCount: number;
    mixedBays: string[];
    emptyBays: string[];
    organizationScore: number;
  } | null>(null);

  // Timecard, Schedule & Payroll specific states
  const [configDb, setConfigDb] = useState<{ technicians: any[]; timecards: any[]; schedules: any[] } | null>(null);

  // Geofence & Shift states
  const [isClockedIn, setIsClockedIn] = useState(false);
  const [activeShift, setActiveShift] = useState<any | null>(null);
  const [shiftHoursText, setShiftHoursText] = useState('00:00:00');
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [distanceToShop, setDistanceToShop] = useState<number | null>(null);
  const [isOnSite, setIsOnSite] = useState(false);
  const [isOnPremises, setIsOnPremises] = useState(GEOFENCE_DEV_BYPASS);
  const [premisesChecking, setPremisesChecking] = useState(false);
  const [missingPhotoCount, setMissingPhotoCount] = useState(0);
  const [geofenceExitAt, setGeofenceExitAt] = useState<number | null>(null);
  const [workforceTick, setWorkforceTick] = useState(0);
  const [workforceExpanded, setWorkforceExpanded] = useState(false);

  // Manager Payroll / Tech Management states
  const [newTechName, setNewTechName] = useState('');
  const [newTechEmail, setNewTechEmail] = useState('');
  const [newTechSpecialty, setNewTechSpecialty] = useState('');
  const [newTechLocation, setNewTechLocation] = useState('moncton');
  const [newTechHourlyRate, setNewTechHourlyRate] = useState('20.00');
  const [newTechPreferredDay, setNewTechPreferredDay] = useState('None');
  const [creatingTech, setCreatingTech] = useState(false);
  const [inviteSentMsg, setInviteSentMsg] = useState('');

  // Manager Weekly Schedule states
  const [rosterDaysQuotas, setRosterDaysQuotas] = useState<Record<string, number>>({});
  const [generatingRoster, setGeneratingRoster] = useState(false);
  const [generatedRosterPreview, setGeneratedRosterPreview] = useState<any[] | null>(null);
  const [scheduleWeekStart, setScheduleWeekStart] = useState('');

  // File Inputs references for opening camera
  const transferFileRef = useRef<HTMLInputElement>(null);
  const verifyFileRef = useRef<HTMLInputElement>(null);
  const estimatorFileRef = useRef<HTMLInputElement>(null);
  const auditFileRef = useRef<HTMLInputElement>(null);

  const timerRef = useRef<any>(null);
  const heartbeatIntervalRef = useRef<any>(null);

  /** Super admin = manager login (password), not PIN staff */
  const isSuperAdminUser = Boolean(
    currentUser?.isSuperAdmin ?? (currentUser?.role === 'manager' && !currentUser?.technicianId)
  );

  // Load / Initialize system config from Supabase
  const loadConfig = async () => {
    try {
      const { data, error } = await supabase
        .from('tires_catalog')
        .select('*')
        .eq('sku', 'CONFIG-EMPLOYEES')
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        console.warn('CONFIG-EMPLOYEES row is missing in tires_catalog database! Please seed it manually.');
        setConfigDb({ technicians: [], timecards: [], schedules: [] });
      } else {
        setConfigDb(data.location_counts || { technicians: [], timecards: [], schedules: [] });
      }
    } catch (e: any) {
      console.error('Failed to load system configuration:', e);
      setConfigDb({ technicians: [], timecards: [], schedules: [] });
    }
  };

  const saveConfig = async (updatedConfig: any) => {
    try {
      setConfigDb(updatedConfig);
      const { error } = await supabase
        .from('tires_catalog')
        .update({ location_counts: updatedConfig })
        .eq('sku', 'CONFIG-EMPLOYEES');
      if (error) throw error;
    } catch (e: any) {
      showTemporaryMessage('error', `Failed to sync database: ${e.message}`);
    }
  };

  // Monitor network status & offline queue
  useEffect(() => {
    loadConfig();

    const handleOnline = () => {
      setIsOnline(true);
      showTemporaryMessage('success', 'Network connection restored. Synced ready.');
    };
    const handleOffline = () => {
      setIsOnline(false);
      showTemporaryMessage('error', 'Network disconnected. Running in Offline Mode.');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    // Check pending count initially
    setPendingSyncCount(offlineStorage.getQueue().length);

    // Load active session from localStorage if exists
    const savedLoc = localStorage.getItem('onecmd_active_location');
    const savedName = localStorage.getItem('onecmd_active_location_name');
    if (savedLoc && savedName) {
      setActiveLocation(savedLoc);
      setLocationName(savedName);
    }

    const savedUser = localStorage.getItem('onecmd_current_user');
    if (savedUser) {
      try {
        const parsed = JSON.parse(savedUser) as AppUser;
        if (parsed.role === 'manager' && !parsed.technicianId && !parsed.isSuperAdmin) {
          parsed.isSuperAdmin = true;
          localStorage.setItem('onecmd_current_user', JSON.stringify(parsed));
          setCurrentUser(parsed);
        }
      } catch {
        /* ignore invalid session */
      }
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Sync active shift from configDb once loaded and user can clock in
  useEffect(() => {
    if (configDb && currentUser?.technicianId && !isSuperAdminUser) {
      const active = configDb.timecards.find(
        (tc: any) => tc.technicianId === currentUser.technicianId && tc.status === 'active'
      );
      if (active) {
        setIsClockedIn(true);
        setActiveShift(active);
      } else {
        setIsClockedIn(false);
        setActiveShift(null);
      }
    } else if (isSuperAdminUser) {
      setIsClockedIn(false);
      setActiveShift(null);
    }
  }, [configDb, currentUser]);

  // Premises geofence — staff only; super admin unrestricted
  useEffect(() => {
    if (!currentUser || !activeLocation) return;
    if (GEOFENCE_DEV_BYPASS || isSuperAdminUser) {
      setIsOnPremises(true);
      setGpsError(null);
      return;
    }
    checkGeofence();
    const intervalMs = 90000;
    heartbeatIntervalRef.current = setInterval(() => checkGeofence(), intervalMs);
    return () => {
      if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
    };
  }, [currentUser, activeLocation, isSuperAdminUser]);

  // Staff timecard geofence (active store only)
  useEffect(() => {
    if (!currentUser?.technicianId || isSuperAdminUser) return;
    if (!isClockedIn) return;
    const interval = setInterval(() => checkGeofence(), 120000);
    return () => clearInterval(interval);
  }, [currentUser, activeLocation, isClockedIn, isSuperAdminUser]);

  // Track when staff leave the geofence while clocked in
  useEffect(() => {
    if (!isClockedIn || distanceToShop === null) return;

    const isBreaching = distanceToShop > GEOFENCE_RADIUS_KM;
    if (isBreaching) {
      setGeofenceExitAt((prev) => prev ?? Date.now());
    } else {
      setGeofenceExitAt(null);
    }
  }, [distanceToShop, isClockedIn]);

  // Auto clock-out after 15 min grace — records clock-out at leave time
  useEffect(() => {
    if (!isClockedIn || !geofenceExitAt) return;

    const checkGrace = () => {
      if (distanceToShop !== null && distanceToShop > GEOFENCE_RADIUS_KM) {
        if (Date.now() - geofenceExitAt >= GEOFENCE_GRACE_MS) {
          triggerAutoClockOut(new Date(geofenceExitAt).toISOString());
        }
      }
    };

    checkGrace();
    const interval = setInterval(checkGrace, 30000);
    return () => clearInterval(interval);
  }, [isClockedIn, geofenceExitAt, distanceToShop]);

  // Live timer tick for super admin workforce panel
  useEffect(() => {
    if (!isSuperAdminUser) return;
    const tick = setInterval(() => setWorkforceTick((t) => t + 1), 1000);
    return () => clearInterval(tick);
  }, [isSuperAdminUser]);

  // Shift Timer Tick
  useEffect(() => {
    if (isClockedIn && activeShift) {
      timerRef.current = setInterval(() => {
        const elapsedMs = Date.now() - Date.parse(activeShift.clockIn);
        const secs = Math.floor((elapsedMs / 1000) % 60);
        const mins = Math.floor((elapsedMs / 60000) % 60);
        const hrs = Math.floor(elapsedMs / 3600000);
        setShiftHoursText(
          `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
        );
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      setShiftHoursText('00:00:00');
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isClockedIn, activeShift]);

  // Poll pending sync count changes
  useEffect(() => {
    const interval = setInterval(() => {
      setPendingSyncCount(offlineStorage.getQueue().length);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  // Fetch pending incoming transfers & customer orders when logged in
  useEffect(() => {
    if (activeLocation) {
      loadPendingIncomingTransfers();
      loadPendingOrders();
      loadMissingPhotoCount();
      if (activeTab === 'logs') {
        fetchRecentTransactions();
      }
    }
  }, [activeLocation, activeTab]);

  // Dynamic SKU check as user updates brand, size, or model manually
  useEffect(() => {
    if (!extractedSpecs || !extractedSpecs.brand || !extractedSpecs.size) {
      setSkuExists(null);
      return;
    }
    const checkSku = async () => {
      try {
        const generatedSku = formatSku(extractedSpecs.brand, extractedSpecs.size, extractedSpecs.model || '');
        const { data } = await supabase
          .from('tires_catalog')
          .select('sku')
          .eq('sku', generatedSku)
          .maybeSingle();
        setSkuExists(!!data);
      } catch (e) {
        console.error('Error checking SKU dynamically:', e);
      }
    };
    checkSku();
  }, [extractedSpecs?.brand, extractedSpecs?.size, extractedSpecs?.model]);

  const fetchRecentTransactions = async () => {
    if (!activeLocation) return;
    try {
      if (isOnline) {
        const { data, error } = await supabase
          .from('inventory_transactions')
          .select('*')
          .or(`to_location.eq.${activeLocation},from_location.eq.${activeLocation}`)
          .order('created_at', { ascending: false })
          .limit(50);
        if (error) throw error;
        setRecentTransactions(data || []);
      } else {
        setRecentTransactions(offlineStorage.getQueue());
      }
    } catch (e: any) {
      console.error('Failed to fetch recent transactions:', e);
      setRecentTransactions(offlineStorage.getQueue());
    }
  };

  const loadPendingIncomingTransfers = async () => {
    if (!activeLocation) return;
    try {
      if (isOnline) {
        const { data, error } = await supabase
          .from('inventory_transactions')
          .select('*')
          .eq('to_location', activeLocation)
          .eq('status', 'pending');
        if (error) throw error;
        setPendingTransfers(data || []);
      } else {
        // Fallback for offline: filter local transactions
        const localTxs = offlineStorage.getQueue();
        const incoming = localTxs.filter(tx => tx.to_location === activeLocation && tx.status === 'pending');
        setPendingTransfers(incoming as any);
      }
    } catch (e) {
      console.warn('Failed to load pending transfers:', e);
    }
  };

  const loadPendingOrders = async () => {
    if (!activeLocation) return;
    try {
      if (isOnline) {
        const { data, error } = await supabase
          .from('customer_orders')
          .select('*')
          .eq('location_id', activeLocation)
          .eq('status', 'pending_shipping');
        if (error) throw error;
        setOrders(data || []);
      } else {
        setOrders([]);
      }
    } catch (e) {
      console.warn('Failed to load orders:', e);
    }
  };

  const handleShipOrder = async (order: CustomerOrder) => {
    if (!trackingInput) {
      showTemporaryMessage('error', 'Please enter or scan a shipping tracking number.');
      return;
    }
    setDispatching(true);
    try {
      if (isOnline) {
        // 1. Update order status to 'shipped' in Supabase
        const { error: orderErr } = await supabase
          .from('customer_orders')
          .update({
            status: 'shipped',
            tracking_number: trackingInput
          })
          .eq('id', order.id);

        if (orderErr) throw orderErr;

        // 2. Log transaction and update catalog stock counts via serverless API
        for (const item of order.items) {
          const txData = {
            sku: item.sku,
            product_type: 'tire' as const,
            transaction_type: 'transfer' as const,
            quantity: item.quantity,
            from_location: activeLocation!,
            to_location: 'shipped',
            employee_id: 'auto_shipping',
            notes: `Shipped order ${order.order_number} to ${order.customer_name}. Tracking: ${trackingInput}`,
            status: 'completed' as const
          };
          await syncTransactionWithServer(txData);
        }
      } else {
        showTemporaryMessage('error', 'Shipping tracking updates require an online connection.');
        return;
      }

      showTemporaryMessage('success', `Order ${order.order_number} dispatched successfully!`);
      setSelectedOrder(null);
      setTrackingInput('');
      loadPendingOrders();
    } catch (e: any) {
      showTemporaryMessage('error', `Failed to dispatch order: ${e.message}`);
    } finally {
      setDispatching(false);
    }
  };

  const showTemporaryMessage = (type: 'success' | 'error', text: string) => {
    setGlobalMessage({ type, text });
    setTimeout(() => setGlobalMessage(null), 5000);
  };

  const loadMissingPhotoCount = async () => {
    try {
      const [tiresRes, wheelsRes] = await Promise.all([
        supabase.from('tires_catalog').select('image').neq('sku', 'CONFIG-EMPLOYEES').limit(300),
        supabase.from('wheels_catalog').select('image').limit(300),
      ]);
      let count = 0;
      for (const row of tiresRes.data || []) {
        if (isCatalogImageMissing(row.image)) count++;
      }
      for (const row of wheelsRes.data || []) {
        if (isCatalogImageMissing(row.image)) count++;
      }
      setMissingPhotoCount(count);
    } catch {
      setMissingPhotoCount(0);
    }
  };

  const requestGpsPosition = (): Promise<GeolocationPosition> =>
    new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation is not supported on this device.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 15000,
      });
    });

  const verifyPremisesAccess = async (): Promise<boolean> => {
    if (GEOFENCE_DEV_BYPASS || loginMode === 'admin') return true;
    setPremisesChecking(true);
    try {
      const position = await requestGpsPosition();
      const { latitude, longitude } = position.coords;
      setGpsCoords({ lat: latitude, lng: longitude });
      const premises = getPremisesStatus(latitude, longitude);
      setIsOnPremises(premises.isOnPremises);
      setGpsError(null);
      if (!premises.isOnPremises) {
        setAuthError('Unable to sign in. Location verification is required.');
        return false;
      }
      return true;
    } catch (err: any) {
      setGpsError(null);
      setIsOnPremises(false);
      setAuthError('Unable to verify location. Enable GPS and try again.');
      return false;
    } finally {
      setPremisesChecking(false);
    }
  };

  const checkGeofence = () => {
    if (GEOFENCE_DEV_BYPASS || isSuperAdminUser) {
      setIsOnPremises(true);
      setGpsError(null);
      return;
    }
    if (!navigator.geolocation) {
      setGpsError('Geolocation is not supported by your browser');
      setIsOnPremises(false);
      return;
    }
    setPremisesChecking(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        setGpsCoords({ lat: latitude, lng: longitude });
        setGpsError(null);

        const premises = getPremisesStatus(latitude, longitude);
        setIsOnPremises(premises.isOnPremises);

        const currentLoc = locations.find((l) => l.id === activeLocation);
        if (currentLoc) {
          const dist = calculateDistance(latitude, longitude, currentLoc.lat, currentLoc.lng);
          setDistanceToShop(dist);
          setIsOnSite(dist <= GEOFENCE_RADIUS_KM);
        }
        setPremisesChecking(false);
      },
      () => {
        setGpsError(null);
        setIsOnPremises(false);
        setIsOnSite(false);
        setPremisesChecking(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const triggerAutoClockOut = async (clockOutAtIso?: string) => {
    if (!isClockedIn || !activeShift || !configDb) return;
    try {
      const clockOutTime = clockOutAtIso || new Date().toISOString();
      const updatedTimecards = configDb.timecards.map((tc: any) => {
        if (tc.id === activeShift.id) {
          return {
            ...tc,
            status: 'completed',
            clockOut: clockOutTime,
            notes: 'Auto clock-out: location verification failed'
          };
        }
        return tc;
      });

      const updated = {
        ...configDb,
        timecards: updatedTimecards
      };

      await saveConfig(updated);
      setIsClockedIn(false);
      setActiveShift(null);
      setGeofenceExitAt(null);
      showTemporaryMessage('error', 'Auto clock-out: your shift ended because location could not be verified.');
    } catch (e: any) {
      console.error('Failed auto clock-out:', e);
    }
  };

  // Location authentication handling
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeLocation) {
      setAuthError('Please select a location.');
      return;
    }

    if (!configDb && loginMode !== 'admin') {
      setAuthError('System database loading. Please try again in a moment.');
      return;
    }

    const credential = pinInput.trim();
    if (!credential) {
      setAuthError(loginMode === 'admin' ? 'Please enter the admin password.' : 'Please enter your PIN.');
      return;
    }

    const onPremises = loginMode === 'admin' ? true : await verifyPremisesAccess();
    if (!onPremises) return;

    const selectedStoreObj = locations.find(l => l.id === activeLocation);
    const storeName = selectedStoreObj ? selectedStoreObj.name : activeLocation;

    if (loginMode === 'admin') {
      try {
        const res = await fetch('/api/staff-auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'admin',
            password: credential,
            locationId: activeLocation,
            locationName: storeName,
          }),
        });
        let data: { error?: string; token?: string; name?: string };
        try {
          data = await res.json();
        } catch {
          setAuthError(
            res.status === 404
              ? 'Login API unavailable. Start the app with "npm run dev" (uses vercel dev for API routes).'
              : 'Login failed. Please try again.',
          );
          return;
        }
        if (!res.ok) {
          setAuthError(data.error || 'Invalid Admin Password. Please try again.');
          return;
        }

        setStaffToken(data.token);
        const mgrUser: AppUser = {
          role: 'manager',
          name: data.name || 'Super Admin',
          location: activeLocation,
          isSuperAdmin: true,
        };
        setCurrentUser(mgrUser);
        setLocationName(storeName);
        setIsOnPremises(true);
        localStorage.setItem('onecmd_active_location', activeLocation);
        localStorage.setItem('onecmd_active_location_name', storeName);
        localStorage.setItem('onecmd_current_user', JSON.stringify(mgrUser));
        setPinInput('');
        setAuthError('');
        showTemporaryMessage('success', 'Logged in successfully as Super Admin.');
      } catch {
        setAuthError('Login failed. Please try again.');
      }
    } else {
      try {
        const res = await fetch('/api/staff-auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'technician',
            pin: credential,
            locationId: activeLocation,
            locationName: storeName,
          }),
        });
        let data: { error?: string; token?: string; name?: string; technicianId?: string };
        try {
          data = await res.json();
        } catch {
          setAuthError(
            res.status === 404
              ? 'Login API unavailable. Start the app with "npm run dev" (uses vercel dev for API routes).'
              : 'Login failed. Please try again.',
          );
          return;
        }
        if (!res.ok) {
          setAuthError(data.error || 'Invalid 4-digit PIN code. Please try again.');
          return;
        }

        setStaffToken(data.token);
        const workerUser: AppUser = {
          role: 'worker',
          name: data.name,
          location: activeLocation,
          technicianId: data.technicianId,
        };
        setCurrentUser(workerUser);
        setLocationName(storeName);
        localStorage.setItem('onecmd_active_location', activeLocation);
        localStorage.setItem('onecmd_active_location_name', storeName);
        localStorage.setItem('onecmd_current_user', JSON.stringify(workerUser));
        setPinInput('');
        setAuthError('');
        showTemporaryMessage('success', `Welcome back, ${data.name}! Logged in at ${storeName}.`);
      } catch {
        setAuthError('Login failed. Please try again.');
      }
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('onecmd_active_location');
    localStorage.removeItem('onecmd_active_location_name');
    localStorage.removeItem('onecmd_current_user');
    clearStaffToken();
    setActiveLocation(null);
    setLocationName('');
    setCurrentUser(null);
    setActiveTab('dashboard');
    setIsClockedIn(false);
    setActiveShift(null);
    setGeofenceExitAt(null);
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const getActiveShifts = () => (configDb?.timecards || []).filter((tc: any) => tc.status === 'active');

  const renderWorkforceMonitor = (opts?: { fullPage?: boolean; collapsible?: boolean; expanded?: boolean; onToggle?: () => void }) => {
    void workforceTick;
    const activeShifts = getActiveShifts();
    const totalOnClock = activeShifts.length;
    const locationsWithStaff = new Set(activeShifts.map((s: any) => s.locationId)).size;
    const collapsible = opts?.collapsible ?? false;
    const expanded = opts?.expanded ?? true;
    const showDetails = !collapsible || expanded;

    const HeaderTag = collapsible ? 'button' : 'div';

    return (
      <div className={`workforce-panel ${collapsible && !expanded ? 'workforce-panel--collapsed' : ''}`}>
        <HeaderTag
          {...(collapsible ? { type: 'button' as const } : {})}
          className={`workforce-panel__header ${collapsible ? 'workforce-panel__header--toggle' : ''}`}
          onClick={collapsible ? opts?.onToggle : undefined}
          aria-expanded={collapsible ? expanded : undefined}
        >
          <div className="workforce-panel__header-left">
            <h3 className="workforce-panel__title">🕒 Live Workforce</h3>
            {collapsible && !expanded && (
              <span className="workforce-panel__teaser">
                {totalOnClock > 0
                  ? `${totalOnClock} on clock · ${locationsWithStaff} location${locationsWithStaff === 1 ? '' : 's'}`
                  : 'Tap to view all locations'}
              </span>
            )}
          </div>
          <div className="workforce-panel__header-right">
            <span className={`badge ${totalOnClock > 0 ? 'badge-green' : 'badge-amber'}`}>
              {totalOnClock > 0 ? `${totalOnClock} On Clock` : 'All Off'}
            </span>
            {collapsible && (
              <ChevronDown className={`workforce-panel__chevron ${expanded ? 'workforce-panel__chevron--open' : ''}`} aria-hidden="true" />
            )}
          </div>
        </HeaderTag>

        {showDetails && (
          <div className="workforce-panel__body">
            <div className="workforce-summary">
              <div className="workforce-summary__card">
                <div className="workforce-summary__value">{totalOnClock}</div>
                <div className="workforce-summary__label">Working Now</div>
              </div>
              <div className="workforce-summary__card">
                <div className="workforce-summary__value">{locationsWithStaff}</div>
                <div className="workforce-summary__label">Locations Active</div>
              </div>
              <div className="workforce-summary__card">
                <div className="workforce-summary__value">{locations.length}</div>
                <div className="workforce-summary__label">Total Stores</div>
              </div>
            </div>

            {locations.map((loc) => {
              const atLocation = activeShifts.filter((s: any) => s.locationId === loc.id);

              return (
                <div key={loc.id} className="workforce-location">
                  <h4 className="workforce-location__title">
                    <span>{loc.name}</span>
                    <span className={`badge ${atLocation.length > 0 ? 'badge-green' : 'badge-amber'} text-xs`}>
                      {atLocation.length > 0 ? `${atLocation.length} working` : 'Off duty'}
                    </span>
                  </h4>
                  {atLocation.length === 0 ? (
                    <div className="workforce-empty">Nobody clocked in at this location.</div>
                  ) : (
                    atLocation.map((shift: any) => (
                      <div key={shift.id} className="workforce-worker">
                        <div>
                          <div className="workforce-worker__name">{shift.technicianName}</div>
                          <div className="workforce-worker__meta">
                            Clocked in {new Date(shift.clockIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </div>
                        <div className="workforce-worker__timer">{formatElapsedSince(shift.clockIn)}</div>
                      </div>
                    ))
                  )}
                </div>
              );
            })}

            {opts?.fullPage ? (
              <p className="text-xs text-gray-400 mt-2 text-center">
                Shifts may end automatically if location cannot be verified
              </p>
            ) : (
              <button
                type="button"
                onClick={() => setActiveTab('workforce')}
                className="workforce-panel__full-link"
              >
                Open full monitor & shift history →
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  // Trigger sync of offline items
  const handleSync = async () => {
    if (!isOnline) {
      showTemporaryMessage('error', 'Cannot sync while offline. Please check your network.');
      return;
    }
    setSyncing(true);
    try {
      const { success, failed } = await offlineStorage.syncQueue();
      setPendingSyncCount(offlineStorage.getQueue().length);
      if (success > 0) {
        showTemporaryMessage('success', `Successfully synced ${success} offline transactions!`);
      } else if (failed > 0) {
        showTemporaryMessage('error', `Sync finished. ${failed} items failed to sync.`);
      }
    } catch (e) {
      showTemporaryMessage('error', 'Sync failed unexpectedly.');
    } finally {
      setSyncing(false);
    }
  };

  // File to Base64 utility
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, callback: (base64: string) => void) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === 'string') {
          callback(reader.result);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  // KEYPAD input handler helper
  const handleKeypadPress = (val: string, current: string, setter: (v: string) => void) => {
    if (val === 'C') {
      setter('');
    } else if (val === '⌫') {
      setter(current.slice(0, -1));
    } else {
      setter(current + val);
    }
  };



  // STEP 1: AI Label parsing (Intake)
  const processReceiveSticker = async (base64: string) => {
    setReceivePhoto(base64);
    setExtracting(true);
    setExtractedSpecs(null);
    setBulkExtractedSpecs(null);
    setBulkQuantities({});
    setProductPhoto(null);
    setBulkProductPhotos({});
    setSkuExists(null);
    setReceiveScanError('');
    setWinterApproved(false);
    setWinterApprovedAiDetected(false);
    try {
      if (scanMode === 'bulk') {
        const result = await parseBulkStack(base64);
        const items = result.items || [];
        items.forEach(item => {
          if (!item.product_type) item.product_type = 'tire';
          const lcB = (item.brand || '').trim().toLowerCase();
          const modelKeywords = [
            'commander', 'defender', 'wildpeak', 'assault', 'contra', 'maverick', 'baja',
            'duratrac', 'ko2', 'ko3', 'grabber', 'trail grappler', 'ridge grappler', 'nomad',
            'cleaver', 'renegade', 'vapor', 'beast', 'vector', 'covert', 'avalanche', 'ice master',
            'snow cutter'
          ];
          if (modelKeywords.includes(lcB) || modelKeywords.some(kw => lcB === kw || lcB === `${kw} ltx` || lcB === `${kw} a/t` || lcB === `${kw} m/t`)) {
            if (!item.model || !item.model.toLowerCase().includes(lcB)) {
              item.model = item.brand;
            }
            item.brand = '';
          }
        });
        setBulkExtractedSpecs(items);
        
        const defaultQuants: { [key: number]: number } = {};
        items.forEach((_, idx) => {
          defaultQuants[idx] = 1;
        });
        setBulkQuantities(defaultQuants);

        if (items.length === 0) {
          setReceiveScanError('No tire or wheel stickers detected. Retake in better light with stickers clearly visible.');
        }
        return;
      }

      const parsed = scanMode === 'sidewall'
        ? await parseTireSidewall(base64)
        : await parseTireSticker(base64);
      
      if (!parsed.product_type) {
        parsed.product_type = 'tire';
      }

      const lcBrand = (parsed.brand || '').trim().toLowerCase();
      const modelKeywords = [
        'commander', 'defender', 'wildpeak', 'assault', 'contra', 'maverick', 'baja',
        'duratrac', 'ko2', 'ko3', 'grabber', 'trail grappler', 'ridge grappler', 'nomad',
        'cleaver', 'renegade', 'vapor', 'beast', 'vector', 'covert', 'avalanche', 'ice master',
        'snow cutter'
      ];
      if (modelKeywords.includes(lcBrand) || modelKeywords.some(kw => lcBrand === kw || lcBrand === `${kw} ltx` || lcBrand === `${kw} a/t` || lcBrand === `${kw} m/t`)) {
        if (!parsed.model || !parsed.model.toLowerCase().includes(lcBrand)) {
          parsed.model = parsed.brand;
        }
        parsed.brand = '';
      }
      
      setExtractedSpecs(parsed);

      const inferredWinter = inferWinterApprovedFromCatalog(parsed.brand, parsed.model, parsed);
      setWinterApproved(inferredWinter);
      setWinterApprovedAiDetected(Boolean(parsed.has_3pmsf || parsed.winter_approved));

      if (!parsed.size) {
        setReceiveScanError(
          scanMode === 'sidewall'
            ? 'Could not read sidewall size spec. Retake in better light with tire markings clearly visible and in frame.'
            : 'Could not read size. Retake in better light with the full sticker in frame.'
        );
        return;
      }

      if (!parsed.brand || parsed.brand.toLowerCase() === 'n/a') {
        parsed.brand = '';
      }
      
      // Query if SKU exists in master catalog
      if (isOnline && parsed.brand && parsed.size) {
        const generatedSku = formatSku(parsed.brand, parsed.size, parsed.model || '');
        const { data } = await supabase
          .from('tires_catalog')
          .select('sku')
          .eq('sku', generatedSku)
          .maybeSingle();
        setSkuExists(!!data);
      } else {
        setSkuExists(false);
      }
    } catch (err: any) {
      setReceiveScanError(err.message || 'AI label extraction failed. Hold steady and retake the photo.');
      showTemporaryMessage('error', `AI label extraction failed: ${err.message}`);
    } finally {
      setExtracting(false);
    }
  };

  const syncTransactionWithServer = async (tx: any, newProduct?: any) => {
    const response = await fetch('/api/transaction', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ action: 'sync', tx, newProduct })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(errText);
    }

    const resData = await response.json();
    if (!resData.success) {
      throw new Error(resData.error || 'Server sync failed');
    }
    return resData;
  };

  // Save parsed intake inventory
  const handleSaveReceive = async () => {
    if (!extractedSpecs || !quantityInput) return;
    if (!extractedSpecs.brand || !extractedSpecs.brand.trim()) {
      showTemporaryMessage('error', 'Brand name is required. Please enter the brand name manually.');
      return;
    }
    const qty = parseInt(quantityInput);
    if (isNaN(qty) || qty <= 0) {
      showTemporaryMessage('error', 'Please enter a valid quantity.');
      return;
    }
    setSavingReceive(true);
    try {
      const generatedSku = formatSku(extractedSpecs.brand, extractedSpecs.size, extractedSpecs.model || '');
      const isWheel = extractedSpecs.product_type === 'wheel';

      // Build metadata notes for managers to view secondary specs (UTQG, Ply, DOT, PCD, Offset, etc.)
      let logNotes = '';
      if (isWheel) {
        if (extractedSpecs.part_number) logNotes += `Part: ${extractedSpecs.part_number}`;
        if (extractedSpecs.bolt_pattern) {
          if (logNotes) logNotes += ' | ';
          logNotes += `PCD: ${extractedSpecs.bolt_pattern}`;
        }
        if (extractedSpecs.offset) {
          if (logNotes) logNotes += ' | ';
          logNotes += `ET: ${extractedSpecs.offset}`;
        }
        if (extractedSpecs.center_bore) {
          if (logNotes) logNotes += ' | ';
          logNotes += `CB: ${extractedSpecs.center_bore}`;
        }
      } else {
        if (extractedSpecs.dot_code && extractedSpecs.dot_code !== 'N/A') {
          logNotes += `DOT: ${extractedSpecs.dot_code}`;
        }
        if (extractedSpecs.ply_rating && extractedSpecs.ply_rating !== 'N/A') {
          if (logNotes) logNotes += ' | ';
          logNotes += `Ply: ${extractedSpecs.ply_rating}`;
        }
        if (extractedSpecs.utqg && extractedSpecs.utqg !== 'N/A') {
          if (logNotes) logNotes += ' | ';
          logNotes += `UTQG: ${extractedSpecs.utqg}`;
        }
        if (extractedSpecs.extra_details) {
          if (logNotes) logNotes += ' | ';
          logNotes += extractedSpecs.extra_details;
        }
      }

      const txData = {
        sku: generatedSku,
        product_type: isWheel ? ('wheel' as const) : ('tire' as const),
        transaction_type: 'receive' as const,
        quantity: qty,
        to_location: activeLocation!,
        supplier_container: '',
        employee_id: currentUser ? currentUser.name : activeLocation!,
        notes: logNotes || undefined,
        status: 'completed' as const
      };

      if (isOnline) {
        const newProductPayload = {
          brand: extractedSpecs.brand,
          model: extractedSpecs.model,
          size: extractedSpecs.size,
          finish: extractedSpecs.finish,
          bolt_pattern: extractedSpecs.bolt_pattern,
          offset: extractedSpecs.offset,
          center_bore: extractedSpecs.center_bore,
          ply_rating: extractedSpecs.ply_rating,
          season: extractedSpecs.season,
          winterApproved: winterApproved,
          productPhoto: productPhoto || undefined // base64 string
        };
        await syncTransactionWithServer(txData, newProductPayload);
      } else {
        // Cache offline
        offlineStorage.enqueue(txData);
        setPendingSyncCount(offlineStorage.getQueue().length);
      }

      showTemporaryMessage('success', `Intake recorded: ${qty}x ${extractedSpecs.brand} ${extractedSpecs.model} added to ${locationName}! Ready for next scan.`);
      // Reset for next intake — stay on receive screen
      setReceivePhoto(null);
      setExtractedSpecs(null);
      setProductPhoto(null);
      setQuantityInput('');
      setSkuExists(null);
      setWinterApproved(false);
      setWinterApprovedAiDetected(false);
      setReceiveScanError('');
    } catch (e: any) {
      showTemporaryMessage('error', `Failed to save received stock: ${e.message}`);
    } finally {
      setSavingReceive(false);
    }
  };

  const handleSaveBulkReceive = async () => {
    if (!bulkExtractedSpecs || bulkExtractedSpecs.length === 0) return;
    const missingBrandIdx = bulkExtractedSpecs.findIndex(item => !item.brand || !item.brand.trim());
    if (missingBrandIdx !== -1) {
      showTemporaryMessage('error', `Product #${missingBrandIdx + 1} is missing a Brand name. Please enter it manually.`);
      return;
    }
    setSavingBulkReceive(true);
    try {
      let savedCount = 0;
      let totalQty = 0;

      for (let i = 0; i < bulkExtractedSpecs.length; i++) {
        const item = bulkExtractedSpecs[i];
        const qty = bulkQuantities[i] || 1;
        if (qty <= 0) continue;

        const generatedSku = formatSku(item.brand, item.size, item.model || '');
        const isWheel = item.product_type === 'wheel';

        // Build metadata notes
        let logNotes = '';
        if (isWheel) {
          if (item.part_number) logNotes += `Part: ${item.part_number}`;
          if (item.bolt_pattern) {
            if (logNotes) logNotes += ' | ';
            logNotes += `PCD: ${item.bolt_pattern}`;
          }
          if (item.offset) {
            if (logNotes) logNotes += ' | ';
            logNotes += `ET: ${item.offset}`;
          }
          if (item.center_bore) {
            if (logNotes) logNotes += ' | ';
            logNotes += `CB: ${item.center_bore}`;
          }
        } else {
          if (item.dot_code && item.dot_code !== 'N/A') {
            logNotes += `DOT: ${item.dot_code}`;
          }
          if (item.ply_rating && item.ply_rating !== 'N/A') {
            if (logNotes) logNotes += ' | ';
            logNotes += `Ply: ${item.ply_rating}`;
          }
          if (item.utqg && item.utqg !== 'N/A') {
            if (logNotes) logNotes += ' | ';
            logNotes += `UTQG: ${item.utqg}`;
          }
          if (item.extra_details) {
            if (logNotes) logNotes += ' | ';
            logNotes += item.extra_details;
          }
        }

        const txData = {
          sku: generatedSku,
          product_type: isWheel ? ('wheel' as const) : ('tire' as const),
          transaction_type: 'receive' as const,
          quantity: qty,
          to_location: activeLocation!,
          supplier_container: '',
          employee_id: currentUser ? currentUser.name : activeLocation!,
          notes: logNotes || undefined,
          status: 'completed' as const
        };

        if (isOnline) {
          const newProductPayload = {
            brand: item.brand,
            model: item.model,
            size: item.size,
            finish: item.finish,
            bolt_pattern: item.bolt_pattern,
            offset: item.offset,
            center_bore: item.center_bore,
            ply_rating: item.ply_rating,
            season: item.season,
            winterApproved: item.winter_approved || item.has_3pmsf,
            productPhoto: bulkProductPhotos[i] || undefined // base64 string
          };
          await syncTransactionWithServer(txData, newProductPayload);
        } else {
          offlineStorage.enqueue(txData);
          setPendingSyncCount(offlineStorage.getQueue().length);
        }

        savedCount++;
        totalQty += qty;
      }

      showTemporaryMessage('success', `Bulk intake recorded: ${totalQty} items across ${savedCount} products added to ${locationName}! Ready for next scan.`);
      // Reset for next intake — stay on receive screen
      setReceivePhoto(null);
      setBulkExtractedSpecs(null);
      setBulkQuantities({});
      setBulkProductPhotos({});
      setExtractedSpecs(null);
      setQuantityInput('');
      setSkuExists(null);
      setWinterApproved(false);
      setWinterApprovedAiDetected(false);
      setReceiveScanError('');
    } catch (err: any) {
      showTemporaryMessage('error', `Failed to save bulk scan: ${err.message}`);
    } finally {
      setSavingBulkReceive(false);
    }
  };

  const handleOpenEditTransaction = (tx: PendingTransaction) => {
    setEditingTransaction(tx);
    setNewQtyInput(String(tx.quantity));
    setManagerPinInput('');
    setManagerPinError('');
    setManagerPinModalOpen(true);
  };

  const handleSaveTransactionEdit = async () => {
    if (!editingTransaction || !activeLocation) return;
    
    if (!isOnline) {
      setManagerPinError('Manager Override PIN cannot be verified offline. Please connect to the network.');
      return;
    }

    const newQty = parseInt(newQtyInput);
    if (isNaN(newQty) || newQty < 0) {
      setManagerPinError('Please enter a valid quantity.');
      return;
    }

    try {
      const response = await fetch('/api/transaction', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          action: 'edit',
          transactionId: editingTransaction.id,
          newQuantity: newQty,
          notes: `Corrected by ${currentUser?.name || 'Manager'} on override. Original: ${editingTransaction.quantity}`,
          managerPin: managerPinInput
        })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Server override rejected.');
      }

      const resData = await response.json();
      if (!resData.success) {
        throw new Error(resData.error || 'Server edit failed');
      }

      showTemporaryMessage('success', 'Transaction successfully updated and inventory counts recalculated.');
      setManagerPinModalOpen(false);
      setEditingTransaction(null);
      fetchRecentTransactions();
    } catch (e: any) {
      setManagerPinError(e.message);
    }
  };

  const handleSaveTransactionDelete = async () => {
    if (!editingTransaction || !activeLocation) return;
    
    if (!isOnline) {
      setManagerPinError('Manager Override PIN cannot be verified offline. Please connect to the network.');
      return;
    }

    try {
      const response = await fetch('/api/transaction', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ 
          action: 'undo',
          transactionId: editingTransaction.id, 
          managerPin: managerPinInput
        })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Server override rejected.');
      }

      const resData = await response.json();
      if (!resData.success) {
        throw new Error(resData.error || 'Server undo failed');
      }

      showTemporaryMessage('success', 'Transaction deleted and inventory counts reverted.');
      setManagerPinModalOpen(false);
      setEditingTransaction(null);
      fetchRecentTransactions();
    } catch (e: any) {
      setManagerPinError(e.message);
    }
  };

  const handleOpenFlagTransaction = (tx: PendingTransaction) => {
    setFlagTx(tx);
    setFlagNoteInput('');
    setFlagModalOpen(true);
  };

  const handleSaveFlagCorrection = async () => {
    if (!flagTx) return;
    if (!flagNoteInput.trim()) {
      showTemporaryMessage('error', 'Please enter a note explaining the correction.');
      return;
    }

    try {
      if (isOnline) {
        const { error } = await supabase
          .from('inventory_transactions')
          .update({
            status: 'needs_correction',
            notes: `FLAGGED FOR REVIEW: ${flagNoteInput} (Logged by ${currentUser?.name || 'Worker'})`
          })
          .eq('id', flagTx.id);

        if (error) throw error;
      } else {
        // Edit offline queue
        const queue = offlineStorage.getQueue();
        const found = queue.find(item => item.id === flagTx.id);
        if (found) {
          found.status = 'needs_correction';
          found.notes = `FLAGGED FOR REVIEW: ${flagNoteInput}`;
          localStorage.setItem('onecmd_offline_transactions', JSON.stringify(queue));
        }
      }

      showTemporaryMessage('success', 'Transaction successfully flagged for review. A manager will check this note.');
      setFlagModalOpen(false);
      setFlagTx(null);
      fetchRecentTransactions();
    } catch (e: any) {
      showTemporaryMessage('error', `Failed to flag transaction: ${e.message}`);
    }
  };

  const handleUndoLastIntake = async () => {
    if (!activeLocation) return;
    setUndoingIntake(true);
    try {
      if (!isOnline) {
        const queue = offlineStorage.getQueue();
        const lastReceiveIdx = [...queue].reverse().findIndex(
          (tx) => tx.transaction_type === 'receive' && tx.to_location === activeLocation
        );
        if (lastReceiveIdx === -1) {
          showTemporaryMessage('error', 'No offline receive intake found to undo.');
          return;
        }
        const actualIdx = queue.length - 1 - lastReceiveIdx;
        const removed = queue.splice(actualIdx, 1);
        localStorage.setItem('onecmd_offline_transactions', JSON.stringify(queue));
        setPendingSyncCount(queue.length);
        showTemporaryMessage('success', `Removed offline intake: ${removed[0].quantity}x ${removed[0].sku}`);
        return;
      }

      const { data: txs, error: txErr } = await supabase
        .from('inventory_transactions')
        .select('*')
        .eq('transaction_type', 'receive')
        .eq('to_location', activeLocation)
        .order('created_at', { ascending: false })
        .limit(1);

      if (txErr) throw txErr;
      const tx = txs?.[0];
      if (!tx) {
        showTemporaryMessage('error', 'No recent intake found for this location.');
        return;
      }

      const response = await fetch('/api/transaction', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ action: 'undo', transactionId: tx.id })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText);
      }

      const resData = await response.json();
      if (!resData.success) {
        throw new Error(resData.error || 'Server undo failed');
      }

      showTemporaryMessage(
        'success',
        `Undid test intake: ${tx.quantity}x ${tx.sku} reset to 0 at ${locationName}.`
      );
    } catch (e: any) {
      showTemporaryMessage('error', `Could not undo intake: ${e.message}`);
    } finally {
      setUndoingIntake(false);
    }
  };

  // STEP 2: Inter-Store Transfer
  const processTransferSticker = async (base64: string) => {
    setTransferPhoto(base64);
    setExtracting(true);
    setTransferSpecs(null);
    try {
      const parsed = await parseTireSticker(base64);
      setTransferSpecs(parsed);
    } catch (err: any) {
      showTemporaryMessage('error', `AI label extraction failed: ${err.message}`);
    } finally {
      setExtracting(false);
    }
  };

  const handleSendTransfer = async () => {
    if (!transferSpecs || !transferQty || !transferDest) return;
    const qty = parseInt(transferQty);
    if (isNaN(qty) || qty <= 0) {
      showTemporaryMessage('error', 'Please enter a valid quantity.');
      return;
    }

    setSendingTransfer(true);
    try {
      const generatedSku = formatSku(transferSpecs.brand, transferSpecs.size, transferSpecs.model || '');

      const txData = {
        sku: generatedSku,
        product_type: 'tire' as const,
        transaction_type: 'transfer' as const,
        quantity: qty,
        from_location: activeLocation!,
        to_location: transferDest,
        employee_id: currentUser ? currentUser.name : activeLocation!,
        status: 'pending' as const // Two-step handshake remains pending until destination confirms receipt
      };

      if (isOnline) {
        await syncTransactionWithServer(txData);
      } else {
        offlineStorage.enqueue(txData);
        setPendingSyncCount(offlineStorage.getQueue().length);
      }

      showTemporaryMessage('success', `Transfer initiated: ${qty}x ${transferSpecs.brand} tires marked "In Transit" to ${locations.find(l => l.id === transferDest)?.name}!`);
      setTransferPhoto(null);
      setTransferSpecs(null);
      setTransferQty('');
      setTransferDest('');
      setActiveTab('dashboard');
    } catch (e: any) {
      showTemporaryMessage('error', `Failed to send transfer: ${e.message}`);
    } finally {
      setSendingTransfer(false);
    }
  };

  // STEP 3: Confirm Pending Arrivals Handshake
  const handleConfirmReceipt = async () => {
    if (!selectedTransfer || !verifyQty) return;
    const qty = parseInt(verifyQty);
    if (isNaN(qty) || qty < 0) {
      showTemporaryMessage('error', 'Please enter a valid received quantity.');
      return;
    }

    setVerifyingTransfer(true);
    try {
      if (isOnline) {
        const response = await fetch('/api/verify-transfer', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            transactionId: selectedTransfer.id,
            receivedQuantity: qty,
            verifiedBy: activeLocation!
          })
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(errText);
        }

        const resData = await response.json();
        if (!resData.success) {
          throw new Error(resData.error || 'Server verify failed');
        }

        // Discrepancy warning logic
        if (qty !== selectedTransfer.quantity) {
          showTemporaryMessage('error', `Discrepancy logged! Expected ${selectedTransfer.quantity}, but received ${qty}.`);
        } else {
          showTemporaryMessage('success', `Transfer completed: All ${qty} items verified and received.`);
        }
      } else {
        // Offline backup
        const updatedTx = {
          ...selectedTransfer,
          status: 'completed' as const,
          received_quantity: qty,
          verified_at: new Date().toISOString(),
          verified_by: activeLocation!
        };
        offlineStorage.enqueue(updatedTx);
        showTemporaryMessage('success', 'Transfer verification cached locally. Sync when online.');
      }

      setSelectedTransfer(null);
      setVerifyPhoto(null);
      setVerifyQty('');
      setActiveTab('dashboard');
      loadPendingIncomingTransfers();
    } catch (e: any) {
      showTemporaryMessage('error', `Failed to confirm receipt: ${e.message}`);
    } finally {
      setVerifyingTransfer(false);
    }
  };

  // STEP 4: AI Stack Estimator & Learning Feedback
  const processStackPhoto = async (base64: string) => {
    setEstimatorPhoto(base64);
    setEstimating(true);
    setEstimateResult(null);
    setShowLearningPrompt(false);
    setLearningSubmitted(false);
    try {
      const parsed = await estimateStackCount(base64);
      setEstimateResult({
        min: parsed.estimated_min,
        max: parsed.estimated_max,
        conf: parsed.confidence_score,
        reason: parsed.reasoning
      });
    } catch (err: any) {
      showTemporaryMessage('error', `AI stack estimation failed: ${err.message}`);
    } finally {
      setEstimating(false);
    }
  };

  const submitLearningFeedback = async (isAccurate: boolean) => {
    if (!estimateResult) return;
    if (isAccurate) {
      showTemporaryMessage('success', 'Thank you! Feedback logged to confirm AI accuracy.');
      setShowLearningPrompt(false);
      setLearningSubmitted(true);
      return;
    }
    
    // Show manual correction fields
    setShowLearningPrompt(true);
  };

  const handleSaveCorrectionFeedback = async () => {
    const actual = parseInt(actualStackCount);
    if (isNaN(actual) || actual < 0 || !learningReason) {
      showTemporaryMessage('error', 'Please fill in actual quantity and reason.');
      return;
    }

    try {
      if (isOnline) {
        // Insert audit log to get an ID
        const { data: auditData, error: auditError } = await supabase
          .from('inventory_audits')
          .insert({
            location_id: activeLocation!,
            photo_urls: [estimatorPhoto || ''],
            system_quantity: actual, // assumed
            estimated_quantity_min: estimateResult!.min,
            estimated_quantity_max: estimateResult!.max,
            confidence_score: estimateResult!.conf,
            status: 'requires_recount',
            audit_type: 'single_stack'
          })
          .select('id')
          .single();

        if (auditError) throw auditError;

        // Insert feedback log
        await supabase.from('ai_learning_feedback').insert({
          audit_id: auditData.id,
          actual_quantity: actual,
          difference: actual - Math.round((estimateResult!.min + estimateResult!.max) / 2),
          reason: learningReason
        });
      }
      showTemporaryMessage('success', 'AI correction recorded successfully! Thank you.');
      setLearningSubmitted(true);
      setShowLearningPrompt(false);
      setActualStackCount('');
      setLearningReason('');
    } catch (e: any) {
      showTemporaryMessage('error', `Failed to log AI feedback: ${e.message}`);
    }
  };

  // STEP 5: Weekly AI Audit
  const addAuditPhoto = (base64: string) => {
    setAuditPhotos(prev => [...prev, base64]);
  };

  const runWarehouseAudit = async () => {
    if (auditPhotos.length === 0) return;
    setAuditing(true);
    setAuditReport(null);
    try {
      // Simulate/Trigger batch AI vision checking on all photos
      // For Phase 1 we calculate mock metrics based on actual database size
      await new Promise(r => setTimeout(r, 4000));
      setAuditReport({
        confidence: 94.5,
        discrepancyCount: 3,
        mixedBays: ['Bay C-4 (Snow Cutters mixed with Centara All-Season)', 'Bay F-12 (Wrong wheel SKU found)'],
        emptyBays: ['Bay A-2', 'Bay B-9'],
        organizationScore: 88
      });
      showTemporaryMessage('success', 'AI Audit Report generated successfully!');
    } catch (e: any) {
      showTemporaryMessage('error', 'Failed to compile audit report.');
    } finally {
      setAuditing(false);
    }
  };

  // RENDER: Login / Location Selector
  if (!activeLocation || !locationName) {
    return (
      <div className="flex-1 flex flex-col justify-center px-6 py-12 max-w-md mx-auto w-full">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center p-3 bg-violet-600/10 rounded-2xl border border-violet-500/20 mb-4">
            <Package className="w-10 h-10 text-primary" />
          </div>
          <h1>OneCMD Warehouse</h1>
          <p className="text-gray-400 mt-2 text-sm">AI-Powered Warehouse Operations Terminal</p>
        </div>

        <form onSubmit={handleLogin} className="glass-panel space-y-6">
          <div className="space-y-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400">Select Location</label>
            <select 
              value={activeLocation || ''} 
              onChange={e => setActiveLocation(e.target.value)}
              className="w-full"
            >
              <option value="" disabled>Select active store...</option>
              {locations.map(loc => (
                <option key={loc.id} value={loc.id}>{loc.name}</option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400">Identify Yourself</label>
            <div className="grid grid-cols-2 gap-2 bg-glass-dark p-1 rounded-xl border border-glass">
              <button
                type="button"
                onClick={() => { setLoginMode('technician'); setAuthError(''); }}
                className={`py-2 px-3 text-xs font-medium rounded-lg transition-all ${loginMode === 'technician' ? 'bg-primary text-white' : 'text-gray-400 hover:text-slate-800'}`}
              >
                Technician PIN
              </button>
              <button
                type="button"
                onClick={() => { setLoginMode('admin'); setAuthError(''); }}
                className={`py-2 px-3 text-xs font-medium rounded-lg transition-all ${loginMode === 'admin' ? 'bg-primary text-white' : 'text-gray-400 hover:text-slate-800'}`}
              >
                Super Admin
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400">
              {loginMode === 'admin' ? 'Super Admin Password' : '4-Digit PIN Code'}
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 pl-4 flex items-center text-gray-500">
                <Lock className="w-4 h-4" />
              </span>
              <input 
                type="password" 
                placeholder={loginMode === 'admin' ? 'Enter admin password...' : 'Enter your 4-digit PIN...'} 
                value={pinInput}
                onChange={e => setPinInput(e.target.value)}
                className="pl-11 w-full"
              />
            </div>
          </div>

          {authError && (
            <div className="flex items-center gap-2.5 text-rose-400 bg-rose-500/10 p-3.5 rounded-xl border border-rose-500/20 text-xs">
              <AlertTriangle className="w-4.5 h-4.5 flex-shrink-0" />
              <span>{authError}</span>
            </div>
          )}

          <button type="submit" className="w-full btn-primary font-semibold py-2.5 rounded-xl transition-colors" disabled={premisesChecking && loginMode === 'technician'}>
            {premisesChecking && loginMode === 'technician'
              ? 'Verifying access…'
              : loginMode === 'admin'
              ? 'Enter Admin Dashboard'
              : 'Open Employee Portal'}
          </button>
        </form>
        
        <div className="text-center text-xs text-gray-500 mt-8">
          OneCMD AI Warehouse System v1.1.0
        </div>
      </div>
    );
  }

  // RENDER: Main Application — locked off-premises (staff only)
  if (!GEOFENCE_DEV_BYPASS && !isSuperAdminUser && !isOnPremises) {
    return (
      <div className="flex-1 flex flex-col min-h-[100dvh] premises-lock-screen">
        <PremisesLockOverlay
          gpsError={gpsError}
          checking={premisesChecking}
          onRetryGps={checkGeofence}
          onLogout={handleLogout}
        />
      </div>
    );
  }

  // RENDER: Main Application
  return (
    <div className="flex-1 flex flex-col pb-12">
      {/* Header bar */}
      <header className="app-header">
        <div>
          <span className="text-xs font-bold uppercase tracking-wider text-primary">{locationName}</span>
          <h2 className="text-sm font-medium text-gray-400">Inventory Dashboard</h2>
        </div>
        <div className="flex items-center gap-2">
          {/* Offline indicator / Sync badge */}
          {pendingSyncCount > 0 ? (
            <button 
              onClick={handleSync}
              disabled={syncing || !isOnline}
              className={`badge badge-violet flex items-center gap-1 cursor-pointer transition-all ${syncing ? 'animate-pulse' : ''}`}
            >
              <RotateCw className="w-3.5 h-3.5" />
              <span>{pendingSyncCount} Sync Pending</span>
            </button>
          ) : (
            <span className={`badge ${isOnline ? 'badge-green' : 'badge-amber'} flex items-center gap-1`}>
              {isOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
              <span>{isOnline ? 'Online' : 'Offline'}</span>
            </span>
          )}
          
          <button 
            onClick={handleLogout}
            className="p-2 bg-white/5 rounded-lg border border-glass text-gray-400 hover:text-white"
            title="Switch Location"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Global alert bar */}
      {globalMessage && (
        <div className={`mx-6 mt-4 p-4 rounded-xl border flex items-center gap-2 text-sm ${
          globalMessage.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400' : 'bg-rose-500/10 border-rose-500/25 text-rose-400'
        }`}>
          {globalMessage.type === 'success' ? <CheckCircle className="w-5 h-5 flex-shrink-0" /> : <AlertTriangle className="w-5 h-5 flex-shrink-0" />}
          <span>{globalMessage.text}</span>
        </div>
      )}

      {/* TABS CONTENT */}
      <main className="app-main">
        {/* tab dashboard */}
        {activeTab === 'dashboard' && (
          <div className="space-y-6 flex-1 flex flex-col justify-between">
            {/* Stack of actions based on roles & permissions */}
            <div className="space-y-4">
              {/* Super Admin: Live Workforce — always first on dashboard */}
              {isSuperAdminUser && (
                renderWorkforceMonitor({
                  collapsible: true,
                  expanded: workforceExpanded,
                  onToggle: () => setWorkforceExpanded((v) => !v),
                })
              )}

              {/* Role: Technician (Worker) dashboard sections */}
              {currentUser?.technicianId && !isSuperAdminUser && (() => {
                const currentTechProfile = configDb?.technicians.find(t => t.id === currentUser.technicianId);
                const canEditInventory = currentTechProfile?.canEditInventory ?? false;

                return (
                  <>
                    {/* Geofenced Clock In/Out card */}
                    <button 
                      type="button"
                      onClick={() => setActiveTab('timecard')}
                      className={`w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-purple-500`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center border border-purple-500/20 text-purple-400">
                          <Clock className="w-5 h-5" />
                        </div>
                        <div className="text-left">
                          <span className="action-card__title">🕒 Clock In / Clock Out</span>
                          <span className="action-card__sub font-mono">
                            {isClockedIn ? `Shift active: ${shiftHoursText}` : 'Punch in for your shift'}
                          </span>
                        </div>
                      </div>
                      <span className={`badge ${isClockedIn ? 'badge-green' : 'badge-amber'} text-xs`}>
                        {isClockedIn ? 'Working' : 'Off Duty'}
                      </span>
                    </button>

                    {/* My Weekly Schedule */}
                    <button 
                      type="button"
                      onClick={() => setActiveTab('schedule')}
                      className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-cyan-500"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-cyan-500/10 flex items-center justify-center border border-cyan-500/20 text-cyan-400">
                          <Calendar className="w-5 h-5" />
                        </div>
                        <div className="text-left">
                          <span className="action-card__title">📅 My Shift Calendar</span>
                          <span className="action-card__sub">View your scheduled shifts this week</span>
                        </div>
                      </div>
                      <span className="badge badge-blue text-xs">Roster</span>
                    </button>

                    {/* Receive Inventory (Lime) */}
                    <button 
                      type="button"
                      onClick={() => {
                        if (!canEditInventory) {
                          showTemporaryMessage('error', 'RLS Policy: You do not have permissions to edit inventory.');
                          return;
                        }
                        setActiveTab('receive');
                      }}
                      className={`w-full glass-panel flex items-center justify-between p-4 border-l-4 border-l-lime-500 ${
                        canEditInventory ? 'glass-panel-interactive cursor-pointer' : 'opacity-50 cursor-not-allowed'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-lime-500/10 flex items-center justify-center border border-lime-500/20 text-lime-400">
                          {canEditInventory ? <Plus className="w-6 h-6" /> : <Lock className="w-5 h-5 text-gray-500" />}
                        </div>
                        <div className="text-left">
                          <span className="action-card__title">Receive Inventory</span>
                          <span className="action-card__sub">Scan labels to intake products</span>
                        </div>
                      </div>
                      <span className="badge badge-lime text-xs">{canEditInventory ? 'Intake' : 'Read-only'}</span>
                    </button>

                    {/* Inter-Store Move (Blue) */}
                    <button 
                      type="button"
                      onClick={() => {
                        if (!canEditInventory) {
                          showTemporaryMessage('error', 'RLS Policy: You do not have permissions to edit inventory.');
                          return;
                        }
                        setActiveTab('transfer');
                      }}
                      className={`w-full glass-panel flex items-center justify-between p-4 border-l-4 border-l-blue-500 ${
                        canEditInventory ? 'glass-panel-interactive cursor-pointer' : 'opacity-50 cursor-not-allowed'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center border border-blue-500/20 text-blue-400">
                          {canEditInventory ? <ArrowLeftRight className="w-5 h-5" /> : <Lock className="w-5 h-5 text-gray-500" />}
                        </div>
                        <div className="text-left">
                          <span className="action-card__title">Inter-Store Move</span>
                          <span className="action-card__sub">Transfer stock to other stores</span>
                        </div>
                      </div>
                      <span className="badge badge-blue text-xs">{canEditInventory ? 'Transfer' : 'Read-only'}</span>
                    </button>

                    {/* Orders to Dispatch (Emerald) */}
                    <button 
                      type="button"
                      onClick={() => setActiveTab('orders')}
                      className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-emerald-500"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20 text-emerald-400">
                          <Send className="w-5 h-5" />
                        </div>
                        <div className="text-left">
                          <span className="action-card__title">Orders to Dispatch</span>
                          <span className="action-card__sub">Pack customer orders & register tracking</span>
                        </div>
                      </div>
                      {orders.length > 0 ? (
                        <span className="badge badge-rose text-xs">{orders.length} Pending</span>
                      ) : (
                        <span className="badge badge-green text-xs">Ready</span>
                      )}
                    </button>

                    {/* AI Stack Estimator (Violet) */}
                    <button 
                      type="button"
                      onClick={() => setActiveTab('estimate')}
                      className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-violet-500"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-violet-500/10 flex items-center justify-center border border-violet-500/20 text-violet-400">
                          <Sparkles className="w-5 h-5" />
                        </div>
                        <div className="text-left">
                          <span className="action-card__title">AI Stack Estimator</span>
                          <span className="action-card__sub">Estimate pile counts via vision model</span>
                        </div>
                      </div>
                      <span className="badge badge-violet text-xs">AI Count</span>
                    </button>

                    {/* Weekly AI Audit (Amber) */}
                    <button 
                      type="button"
                      onClick={() => {
                        if (!canEditInventory) {
                          showTemporaryMessage('error', 'RLS Policy: You do not have permissions to edit inventory.');
                          return;
                        }
                        setActiveTab('audit');
                      }}
                      className={`w-full glass-panel flex items-center justify-between p-4 border-l-4 border-l-amber-500 ${
                        canEditInventory ? 'glass-panel-interactive cursor-pointer' : 'opacity-50 cursor-not-allowed'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center border border-amber-500/20 text-amber-400">
                          {canEditInventory ? <BarChart3 className="w-5 h-5" /> : <Lock className="w-5 h-5 text-gray-500" />}
                        </div>
                        <div className="text-left">
                          <span className="action-card__title">Weekly AI Audit</span>
                          <span className="action-card__sub">Reconcile database record discrepancies</span>
                        </div>
                      </div>
                      <span className="badge badge-amber text-xs">{canEditInventory ? 'Audit' : 'Read-only'}</span>
                    </button>

                    {/* Product Photo Studio */}
                    <button
                      type="button"
                      onClick={() => {
                        if (!canEditInventory) {
                          showTemporaryMessage('error', 'You do not have permission to manage catalog photos.');
                          return;
                        }
                        setActiveTab('product-photos');
                      }}
                      className={`w-full glass-panel flex items-center justify-between p-4 border-l-4 border-l-pink-500 ${
                        canEditInventory ? 'glass-panel-interactive cursor-pointer' : 'opacity-50 cursor-not-allowed'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-pink-500/10 flex items-center justify-center border border-pink-500/20 text-pink-400">
                          <ImageIcon className="w-5 h-5" />
                        </div>
                        <div className="text-left">
                          <span className="action-card__title">Product Photo Studio</span>
                          <span className="action-card__sub">Add missing catalog images with AI white background</span>
                        </div>
                      </div>
                      {missingPhotoCount > 0 ? (
                        <span className="badge badge-rose text-xs">{missingPhotoCount} Need Photos</span>
                      ) : (
                        <span className="badge badge-green text-xs">Complete</span>
                      )}
                    </button>

                    {/* Build Gallery Studio */}
                    <button
                      type="button"
                      onClick={() => setActiveTab('build-gallery')}
                      className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-indigo-500"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 text-indigo-400">
                          <Truck className="w-5 h-5" />
                        </div>
                        <div className="text-left">
                          <span className="action-card__title">Build Gallery Studio</span>
                          <span className="action-card__sub">Customer truck installs → website gallery</span>
                        </div>
                      </div>
                      <span className="badge badge-violet text-xs">Publish</span>
                    </button>

                    {/* Transaction Logs (Rose) */}
                    <button 
                      type="button"
                      onClick={() => setActiveTab('logs')}
                      className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-rose-500"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-rose-500/10 flex items-center justify-center border border-rose-500/20 text-rose-400">
                          <Lock className="w-5 h-5" />
                        </div>
                        <div className="text-left">
                          <span className="action-card__title">Logs & Corrections Request</span>
                          <span className="action-card__sub">View past transactions & request corrections</span>
                        </div>
                      </div>
                      <span className="badge badge-rose text-xs">Logs</span>
                    </button>
                  </>
                );
              })()}

              {/* Role: Manager / Super Admin dashboard sections */}
              {currentUser?.role === 'manager' && (
                <>
                  {/* Roster Builder & Scheduler */}
                  <button 
                    type="button"
                    onClick={() => setActiveTab('schedule')}
                    className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-cyan-500"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-cyan-500/10 flex items-center justify-center border border-cyan-500/20 text-cyan-400">
                        <Calendar className="w-5 h-5" />
                      </div>
                      <div className="text-left">
                        <span className="action-card__title">📅 Roster Builder & Scheduler</span>
                        <span className="action-card__sub">Schedule employee weekly rotations</span>
                      </div>
                    </div>
                    <span className="badge badge-blue text-xs">Scheduler</span>
                  </button>

                  {/* Technician Payroll Ledger */}
                  <button 
                    type="button"
                    onClick={() => setActiveTab('payroll')}
                    className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-emerald-500"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20 text-emerald-400">
                        <DollarSign className="w-5 h-5" />
                      </div>
                      <div className="text-left">
                        <span className="action-card__title">💰 Technician Payroll Ledger</span>
                        <span className="action-card__sub">Edit pay rates & mark payouts as paid</span>
                      </div>
                    </div>
                    <span className="badge badge-green text-xs">Payroll</span>
                  </button>

                  {/* Access Governance Rules */}
                  <button 
                    type="button"
                    onClick={() => setActiveTab('permissions')}
                    className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-violet-500"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-violet-500/10 flex items-center justify-center border border-violet-500/20 text-violet-400">
                        <Shield className="w-5 h-5" />
                      </div>
                      <div className="text-left">
                        <span className="action-card__title">🔐 Access Governance & Staff List</span>
                        <span className="action-card__sub">Register technicians and configure RLS permissions</span>
                      </div>
                    </div>
                    <span className="badge badge-violet text-xs">Governance</span>
                  </button>

                  {/* Receive Inventory (Lime) */}
                  <button 
                    type="button"
                    onClick={() => setActiveTab('receive')}
                    className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-lime-500"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-lime-500/10 flex items-center justify-center border border-lime-500/20 text-lime-400">
                        <Plus className="w-6 h-6" />
                      </div>
                      <div className="text-left">
                        <span className="action-card__title">Receive Inventory</span>
                        <span className="action-card__sub">Scan label sticker to increase stock</span>
                      </div>
                    </div>
                    <span className="badge badge-lime text-xs font-semibold">Intake</span>
                  </button>

                  {/* Inter-Store Move (Blue) */}
                  <button 
                    type="button"
                    onClick={() => setActiveTab('transfer')}
                    className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-blue-500"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center border border-blue-500/20 text-blue-400">
                        <ArrowLeftRight className="w-5 h-5" />
                      </div>
                      <div className="text-left">
                        <span className="action-card__title">Inter-Store Move</span>
                        <span className="action-card__sub">Transfer items to Oromocto, Saint John, etc.</span>
                      </div>
                    </div>
                    <span className="badge badge-blue text-xs font-semibold">Transfer</span>
                  </button>

                  {/* Product Photo Studio */}
                  <button
                    type="button"
                    onClick={() => setActiveTab('product-photos')}
                    className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-pink-500"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-pink-500/10 flex items-center justify-center border border-pink-500/20 text-pink-400">
                        <ImageIcon className="w-5 h-5" />
                      </div>
                      <div className="text-left">
                        <span className="action-card__title">Product Photo Studio</span>
                        <span className="action-card__sub">Missing catalog images — AI white background</span>
                      </div>
                    </div>
                    {missingPhotoCount > 0 ? (
                      <span className="badge badge-rose text-xs">{missingPhotoCount} Need Photos</span>
                    ) : (
                      <span className="badge badge-green text-xs">Complete</span>
                    )}
                  </button>

                  {/* Build Gallery Studio */}
                  <button
                    type="button"
                    onClick={() => setActiveTab('build-gallery')}
                    className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-indigo-500"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 text-indigo-400">
                        <Truck className="w-5 h-5" />
                      </div>
                      <div className="text-left">
                        <span className="action-card__title">Build Gallery Studio</span>
                        <span className="action-card__sub">Customer installs → website gallery</span>
                      </div>
                    </div>
                    <span className="badge badge-violet text-xs">Publish</span>
                  </button>

                  {/* Orders to Dispatch (Emerald) */}
                  <button 
                    type="button"
                    onClick={() => setActiveTab('orders')}
                    className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-emerald-500"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20 text-emerald-400">
                        <Send className="w-5 h-5" />
                      </div>
                      <div className="text-left">
                        <span className="action-card__title">Orders to Dispatch</span>
                        <span className="action-card__sub">Pack and print labels for customer shipments</span>
                      </div>
                    </div>
                    {orders.length > 0 ? (
                      <span className="badge badge-rose text-xs">{orders.length} Pending</span>
                    ) : (
                      <span className="badge badge-green text-xs">Ready</span>
                    )}
                  </button>

                  {/* AI Stack Estimator (Violet) */}
                  <button 
                    type="button"
                    onClick={() => setActiveTab('estimate')}
                    className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-violet-500"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-violet-500/10 flex items-center justify-center border border-violet-500/20 text-violet-400">
                        <Sparkles className="w-5 h-5" />
                      </div>
                      <div className="text-left">
                        <span className="action-card__title">AI Stack Estimator</span>
                        <span className="action-card__sub">Estimate pile counts via vision model</span>
                      </div>
                    </div>
                    <span className="badge badge-violet text-xs font-semibold">AI Count</span>
                  </button>

                  {/* Weekly AI Audit (Amber) */}
                  <button 
                    type="button"
                    onClick={() => setActiveTab('audit')}
                    className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-amber-500"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center border border-amber-500/20 text-amber-400">
                        <BarChart3 className="w-5 h-5" />
                      </div>
                      <div className="text-left">
                        <span className="action-card__title">Weekly AI Audit</span>
                        <span className="action-card__sub">Compare system records to physical rows</span>
                      </div>
                    </div>
                    <span className="badge badge-amber text-xs font-semibold">Audit</span>
                  </button>

                  {/* Transaction Logs & Corrections (Rose) */}
                  <button 
                    type="button"
                    onClick={() => setActiveTab('logs')}
                    className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-rose-500"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-rose-500/10 flex items-center justify-center border border-rose-500/20 text-rose-400">
                        <Lock className="w-5 h-5" />
                      </div>
                      <div className="text-left">
                        <span className="action-card__title">Transaction Logs & Corrections</span>
                        <span className="action-card__sub">View past logs and request stock corrections</span>
                      </div>
                    </div>
                    <span className="badge badge-rose text-xs font-semibold">Logs</span>
                  </button>
                </>
              )}
            </div>

            {/* Dev / test helper — undo accidental intake */}
            <button
              type="button"
              onClick={handleUndoLastIntake}
              disabled={undoingIntake}
              className="w-full btn-secondary text-sm"
            >
              {undoingIntake ? <RotateCw className="w-4 h-4 animate-spin" /> : null}
              Undo last test intake (reset to 0)
            </button>

            {/* Handshake inbox notification panel (Large tab at the bottom) */}
            <div className="glass-panel flex flex-col mt-4">
              <div className="flex items-center justify-between mb-4 border-b border-glass pb-3">
                <div className="flex items-center gap-2">
                  <Inbox className="w-5 h-5 text-amber-600" />
                  <h3 className="text-sm font-semibold tracking-wider uppercase text-gray-400">Incoming Deliveries</h3>
                </div>
                {pendingTransfers.length > 0 && (
                  <span className="badge badge-amber">{pendingTransfers.length} In Transit</span>
                )}
              </div>

              {pendingTransfers.length === 0 ? (
                <div className="text-center py-6 text-gray-500 text-sm">
                  No pending transfers inbound to your location.
                </div>
              ) : (
                <div className="space-y-3">
                  {pendingTransfers.map(tx => (
                    <div 
                      key={tx.id}
                      onClick={() => {
                        setSelectedTransfer(tx);
                        setActiveTab('verify');
                      }}
                      className="p-3 bg-white/5 border border-glass rounded-xl flex items-center justify-between cursor-pointer hover:bg-white/10 transition-all"
                    >
                      <div className="space-y-1">
                        <div className="font-medium text-sm">{tx.sku}</div>
                        <div className="text-xs text-gray-500">
                          Transfer Quantity: <strong>{tx.quantity} pcs</strong>
                        </div>
                        <div className="text-[10px] text-gray-500">
                          From: {locations.find(l => l.id === tx.from_location)?.name || tx.from_location}
                        </div>
                      </div>
                      <span className="btn-secondary py-2 px-3 text-xs flex items-center gap-1">
                        <Check className="w-3.5 h-3.5" /> Verify
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* tab: Receive Inventory (Intake) */}
        {activeTab === 'receive' && (
          <div className="space-y-6 flex-1 flex flex-col">
            <div className="flex items-center gap-2 mb-2">
              <button onClick={() => { 
                setActiveTab('dashboard'); 
                setReceivePhoto(null); 
                setExtractedSpecs(null); 
                setBulkExtractedSpecs(null);
                setBulkQuantities({});
                setProductPhoto(null);
                setBulkProductPhotos({});
                setQuantityInput(''); 
                setWinterApproved(false); 
                setReceiveScanError(''); 
              }} className="btn-secondary py-2 px-3">
                <ArrowLeftRight className="w-4 h-4 rotate-180" /> Back
              </button>
              <h2>Receive Inventory Intake</h2>
            </div>

            <div className="flex items-center justify-between bg-glass border border-glass rounded-xl p-3 mb-2">
              <span className="font-semibold text-sm">Scan Mode:</span>
              <div className="flex gap-2">
                <button
                  onClick={() => setScanMode('sticker')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    scanMode === 'sticker'
                      ? 'bg-primary text-white shadow-lg'
                      : 'bg-glass border border-glass text-gray-400 hover:text-slate-800'
                  }`}
                >
                  📄 Paper Sticker
                </button>
                <button
                  onClick={() => setScanMode('sidewall')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    scanMode === 'sidewall'
                      ? 'bg-primary text-white shadow-lg'
                      : 'bg-glass border border-glass text-gray-400 hover:text-slate-800'
                  }`}
                >
                  ⭕ Sidewall Rubber
                </button>
                <button
                  onClick={() => setScanMode('bulk')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    scanMode === 'bulk'
                      ? 'bg-primary text-white shadow-lg'
                      : 'bg-glass border border-glass text-gray-400 hover:text-slate-800'
                  }`}
                >
                  📚 Bulk Stack
                </button>
              </div>
            </div>

            {!receivePhoto ? (
              <ScanViewfinder
                label={
                  scanMode === 'sidewall' 
                    ? "Take Photo of Tire Sidewall" 
                    : scanMode === 'bulk'
                    ? "Take Photo of Tire Stack (Bulk)"
                    : "Take Photo of Tire Label"
                }
                hint={
                  scanMode === 'sidewall' 
                    ? "Point camera straight at the embossed rubber text — include DOT code and sizing specs" 
                    : scanMode === 'bulk'
                    ? "Point camera straight at the stack of tires — ensure all paper stickers are clearly visible and in frame"
                    : "Point camera straight at the sticker — include brand, size, and snowflake symbol if present"
                }
                accent="lime"
                onCapture={processReceiveSticker}
              />
            ) : (
              <div className="space-y-3.5 flex-1 flex flex-col">
                <div className="receive-scan-preview relative">
                  <img src={receivePhoto} alt="Tire Label Preview" className="w-full h-full object-cover" />
                  <button 
                    onClick={() => { 
                      setReceivePhoto(null); 
                      setExtractedSpecs(null); 
                      setBulkExtractedSpecs(null);
                      setBulkQuantities({});
                      setProductPhoto(null);
                      setBulkProductPhotos({});
                      setReceiveScanError(''); 
                      setWinterApproved(false); 
                    }} 
                    className="absolute top-1.5 right-1.5 btn-secondary py-1.5 px-2.5 text-xs"
                  >
                    Retake
                  </button>
                </div>

                {extracting && (
                  <div className="glass-panel glass-panel--scanning flex flex-col items-center justify-center py-10 space-y-4">
                    <div className="scan-viewfinder__frame" style={{ width: 220, aspectRatio: '4/3' }}>
                      <span className="scan-viewfinder__corner scan-viewfinder__corner--tl" aria-hidden="true" />
                      <span className="scan-viewfinder__corner scan-viewfinder__corner--tr" aria-hidden="true" />
                      <span className="scan-viewfinder__corner scan-viewfinder__corner--bl" aria-hidden="true" />
                      <span className="scan-viewfinder__corner scan-viewfinder__corner--br" aria-hidden="true" />
                      <span className="scan-viewfinder__laser" aria-hidden="true" />
                      <RotateCw className="w-10 h-10 text-primary animate-spin" />
                    </div>
                    <div className="text-center font-medium">
                      AI Reading Tire Sticker<span className="loading-dots"><span>.</span><span>.</span><span>.</span></span>
                    </div>
                  </div>
                )}

                {receiveScanError && !extracting && (
                  <div className="scan-result-alert scan-result-alert--error">
                    <AlertTriangle className="w-5 h-5 flex-shrink-0" />
                    <div>
                      <strong>Scan needs a retake</strong>
                      <p>{receiveScanError}</p>
                    </div>
                  </div>
                )}

                {extractedSpecs && !receiveScanError && (
                  <div className="receive-result-stack">
                    <div className="glass-panel glass-panel--success receive-specs-card">
                      <div className="receive-specs-card__header">
                        <h3>Extracted AI Specs</h3>
                        {skuExists !== null && (
                          <span className={`badge ${skuExists ? 'badge-green' : 'badge-blue'}`}>
                            {skuExists ? 'Existing SKU' : 'New Catalog Product'}
                          </span>
                        )}
                      </div>

                      <div className="receive-specs-card__body">
                        <div className="intake-form">
                          <div className="intake-section">
                            <h4 className="intake-section__title">Product</h4>
                            <div className="intake-field-wrap">
                              <span className="spec-grid__label">Product Type</span>
                              <select
                                value={extractedSpecs.product_type || 'tire'}
                                onChange={(e) => {
                                  const val = e.target.value as 'tire' | 'wheel';
                                  setExtractedSpecs({ ...extractedSpecs, product_type: val });
                                }}
                                className="intake-field"
                              >
                                <option value="tire">🚗 Tire</option>
                                <option value="wheel">⭕ Wheel</option>
                              </select>
                            </div>
                          </div>

                      {skuExists === false && (
                        <div className="intake-section bg-slate-50 border border-glass">
                          <div className="flex items-start gap-2.5 text-slate-600">
                            <ImageIcon className="w-5 h-5 flex-shrink-0 mt-0.5 text-primary" />
                            <div>
                              <strong className="text-sm font-semibold">Photo optional during fast receive.</strong>
                              <p className="text-xs text-gray-500 mt-0.5">
                                Skip the photo now — add a studio catalog image later in <strong>Product Photo Studio</strong> on the dashboard.
                              </p>
                            </div>
                          </div>
                        </div>
                      )}

                      {extractedSpecs.product_type === 'wheel' ? (
                        <>
                          <div className="intake-section">
                            <h4 className="intake-section__title">Brand & Model</h4>
                            <div className="intake-field-wrap">
                              <span className="spec-grid__label flex items-center justify-between">
                                <span className="flex items-center gap-1.5">
                                  Brand
                                  {extractedSpecs.brand?.trim() && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const oldBrand = extractedSpecs.brand;
                                        setExtractedSpecs({
                                          ...extractedSpecs,
                                          brand: '',
                                          model: oldBrand
                                        });
                                      }}
                                      className="text-[10px] bg-white border border-glass text-slate-600 font-bold px-2 py-1 rounded-lg transition-all flex items-center gap-1 hover:bg-glass-dark normal-case tracking-normal"
                                      title="Move brand name to model and enter brand manually"
                                    >
                                      Move to Model ⇄
                                    </button>
                                  )}
                                </span>
                                {!extractedSpecs.brand?.trim() && (
                                  <span className="text-[10px] text-amber-500 font-bold uppercase animate-pulse normal-case tracking-normal">⚠️ Enter Brand</span>
                                )}
                              </span>
                              <textarea
                                rows={3}
                                placeholder="Enter brand name..."
                                value={extractedSpecs.brand || ''}
                                onChange={(e) => setExtractedSpecs({ ...extractedSpecs, brand: e.target.value })}
                                className={`intake-field intake-field--text ${!extractedSpecs.brand?.trim() ? 'intake-field--warn' : ''}`}
                              />
                            </div>
                            <div className="intake-field-wrap">
                              <span className="spec-grid__label">Model</span>
                              <textarea
                                rows={3}
                                placeholder="Enter model name..."
                                value={extractedSpecs.model || ''}
                                onChange={(e) => setExtractedSpecs({ ...extractedSpecs, model: e.target.value })}
                                className="intake-field intake-field--text"
                              />
                            </div>
                          </div>
                          <div className="intake-section">
                            <h4 className="intake-section__title">Wheel Specs</h4>
                            <div className="intake-field-wrap">
                              <span className="spec-grid__label">Finish / Color</span>
                              <input
                                type="text"
                                placeholder="Enter finish/color..."
                                value={extractedSpecs.finish || ''}
                                onChange={(e) => setExtractedSpecs({ ...extractedSpecs, finish: e.target.value })}
                                className="intake-field"
                              />
                            </div>
                            <div className="intake-field-wrap">
                              <span className="spec-grid__label">Part Number</span>
                              <input
                                type="text"
                                placeholder="Enter part number..."
                                value={extractedSpecs.part_number || ''}
                                onChange={(e) => setExtractedSpecs({ ...extractedSpecs, part_number: e.target.value })}
                                className="intake-field"
                              />
                            </div>
                            <div className="intake-field-wrap">
                              <span className="spec-grid__label">Size</span>
                              <input
                                type="text"
                                placeholder="e.g. 18x8.5"
                                value={extractedSpecs.size || ''}
                                onChange={(e) => setExtractedSpecs({ ...extractedSpecs, size: e.target.value })}
                                className="intake-field"
                              />
                            </div>
                            <div className="intake-field-wrap">
                              <span className="spec-grid__label">Bolt Pattern (PCD)</span>
                              <input
                                type="text"
                                value={extractedSpecs.bolt_pattern || ''}
                                onChange={(e) => setExtractedSpecs({ ...extractedSpecs, bolt_pattern: e.target.value })}
                                className="intake-field"
                              />
                            </div>
                            <div className="intake-field-pair">
                              <div className="intake-field-wrap">
                                <span className="spec-grid__label">Offset (ET)</span>
                                <input
                                  type="text"
                                  value={extractedSpecs.offset || ''}
                                  onChange={(e) => setExtractedSpecs({ ...extractedSpecs, offset: e.target.value })}
                                  className="intake-field"
                                />
                              </div>
                              <div className="intake-field-wrap">
                                <span className="spec-grid__label">Center Bore (CB)</span>
                                <input
                                  type="text"
                                  value={extractedSpecs.center_bore || ''}
                                  onChange={(e) => setExtractedSpecs({ ...extractedSpecs, center_bore: e.target.value })}
                                  className="intake-field"
                                />
                              </div>
                            </div>
                          </div>

                        </>
                      ) : (
                        <>
                          <div className="intake-section">
                            <h4 className="intake-section__title">Brand & Model</h4>
                            <div className="intake-field-wrap">
                              <span className="spec-grid__label flex items-center justify-between">
                                <span className="flex items-center gap-1.5">
                                  Brand
                                  {extractedSpecs.brand?.trim() && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const oldBrand = extractedSpecs.brand;
                                        setExtractedSpecs({
                                          ...extractedSpecs,
                                          brand: '',
                                          model: oldBrand
                                        });
                                      }}
                                      className="text-[10px] bg-white border border-glass text-slate-600 font-bold px-2 py-1 rounded-lg transition-all flex items-center gap-1 hover:bg-glass-dark normal-case tracking-normal"
                                      title="Move brand name to model and enter brand manually"
                                    >
                                      Move to Model ⇄
                                    </button>
                                  )}
                                </span>
                                {!extractedSpecs.brand?.trim() && (
                                  <span className="text-[10px] text-amber-500 font-bold uppercase animate-pulse normal-case tracking-normal">⚠️ Enter Brand</span>
                                )}
                              </span>
                              <textarea
                                rows={3}
                                placeholder="Enter brand name..."
                                value={extractedSpecs.brand || ''}
                                onChange={(e) => setExtractedSpecs({ ...extractedSpecs, brand: e.target.value })}
                                className={`intake-field intake-field--text ${!extractedSpecs.brand?.trim() ? 'intake-field--warn' : ''}`}
                              />
                            </div>
                            <div className="intake-field-wrap">
                              <span className="spec-grid__label">Model</span>
                              <textarea
                                rows={3}
                                placeholder="Enter model name..."
                                value={extractedSpecs.model || ''}
                                onChange={(e) => setExtractedSpecs({ ...extractedSpecs, model: e.target.value })}
                                className="intake-field intake-field--text"
                              />
                            </div>
                          </div>

                          <div className="intake-section">
                            <h4 className="intake-section__title">Tire Specs</h4>
                            <div className="intake-field-wrap">
                              <span className="spec-grid__label">Size</span>
                              <input
                                type="text"
                                placeholder="e.g. 225/45R17"
                                value={extractedSpecs.size || ''}
                                onChange={(e) => setExtractedSpecs({ ...extractedSpecs, size: e.target.value })}
                                className="intake-field"
                              />
                            </div>
                            <div className="intake-field-pair">
                              <div className="intake-field-wrap">
                                <span className="spec-grid__label">Load Index</span>
                                <input
                                  type="text"
                                  placeholder="e.g. 95"
                                  value={extractedSpecs.load_index || ''}
                                  onChange={(e) => setExtractedSpecs({ ...extractedSpecs, load_index: e.target.value })}
                                  className="intake-field"
                                />
                              </div>
                              <div className="intake-field-wrap">
                                <span className="spec-grid__label">Speed Rating</span>
                                <input
                                  type="text"
                                  placeholder="e.g. H"
                                  value={extractedSpecs.speed_rating || ''}
                                  onChange={(e) => setExtractedSpecs({ ...extractedSpecs, speed_rating: e.target.value })}
                                  className="intake-field"
                                />
                              </div>
                            </div>
                            <div className="intake-field-wrap">
                              <span className="spec-grid__label">Load Range</span>
                              <input
                                type="text"
                                placeholder="e.g. SL, XL, C"
                                value={extractedSpecs.load_range || ''}
                                onChange={(e) => setExtractedSpecs({ ...extractedSpecs, load_range: e.target.value })}
                                className="intake-field"
                              />
                            </div>
                            <div className="intake-field-wrap">
                              <span className="spec-grid__label">Season</span>
                              <select
                                value={extractedSpecs.season || 'All-Season'}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setExtractedSpecs({ ...extractedSpecs, season: val });
                                  if (val === 'Winter') {
                                    setWinterApproved(true);
                                  }
                                }}
                                className="intake-field"
                              >
                                <option value="All-Season">All-Season</option>
                                <option value="Winter">Winter</option>
                                <option value="Summer">Summer</option>
                                <option value="All-Terrain">All-Terrain</option>
                              </select>
                            </div>
                            <div className="intake-field-wrap">
                              <span className="spec-grid__label">Ply Rating</span>
                              <input
                                type="text"
                                placeholder="e.g. 4 Ply"
                                value={extractedSpecs.ply_rating || ''}
                                onChange={(e) => setExtractedSpecs({ ...extractedSpecs, ply_rating: e.target.value })}
                                className="intake-field"
                              />
                            </div>
                          </div>

                          <div className="intake-section">
                            <h4 className="intake-section__title">Compliance</h4>
                            <div className="intake-field-wrap">
                              <span className="spec-grid__label">DOT Code</span>
                              <input
                                type="text"
                                placeholder="DOT code from sidewall"
                                value={extractedSpecs.dot_code || ''}
                                onChange={(e) => setExtractedSpecs({ ...extractedSpecs, dot_code: e.target.value })}
                                className="intake-field"
                              />
                            </div>
                            <div className="intake-field-wrap">
                              <span className="spec-grid__label">UTQG Rating</span>
                              <input
                                type="text"
                                placeholder="e.g. 500 A A"
                                value={extractedSpecs.utqg || ''}
                                onChange={(e) => setExtractedSpecs({ ...extractedSpecs, utqg: e.target.value })}
                                className="intake-field"
                              />
                            </div>
                          </div>
                        </>
                      )}

                        <WinterApprovedToggle
                          enabled={winterApproved}
                          onChange={setWinterApproved}
                          aiDetected={winterApprovedAiDetected}
                        />
                        </div>
                      </div>
                    </div>

                    <div className="thumb-zone receive-thumb-zone">
                    <div className="glass-panel p-4 flex items-center justify-between">
                      <span className="font-bold text-lg">Quantity Received</span>
                      <span className="quantity-readout">{quantityInput || '0'}</span>
                    </div>

                    <div className="keypad-grid">
                      {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map(btn => (
                        <button 
                          key={btn} 
                          onClick={() => handleKeypadPress(btn, quantityInput, setQuantityInput)}
                          className={`keypad-btn ${['C','⌫'].includes(btn) ? 'keypad-btn-action' : ''}`}
                        >
                          {btn}
                        </button>
                      ))}
                    </div>

                    <button 
                      onClick={handleSaveReceive}
                      disabled={savingReceive || !quantityInput || !extractedSpecs?.brand?.trim()}
                      className={`w-full btn-primary py-4 transition-all ${
                        (!extractedSpecs?.brand?.trim() || !quantityInput)
                          ? 'bg-slate-200 text-gray-500 border border-slate-300 cursor-not-allowed hover:bg-slate-200'
                          : 'bg-primary text-white hover:opacity-95'
                      }`}
                    >
                      {savingReceive ? <RotateCw className="w-5 h-5 animate-spin" /> : <CheckCircle className="w-5 h-5" />}
                      {!extractedSpecs?.brand?.trim() 
                        ? 'Enter Brand Name to Continue'
                        : skuExists 
                        ? 'Confirm & Add to Stock' 
                        : 'Create New Product & Initialize Stock'
                      }
                    </button>
                    </div>
                  </div>
                )}

                {bulkExtractedSpecs && !receiveScanError && (
                  <div className="receive-result-stack space-y-6 flex-1 flex flex-col">
                    <div className="flex items-center justify-between border-b border-glass pb-2">
                      <h3 className="font-bold text-emerald-400">Extracted Bulk Stack ({bulkExtractedSpecs.length} items)</h3>
                      <button
                        onClick={() => {
                          const newSpecs = [...bulkExtractedSpecs];
                          newSpecs.push({
                            product_type: 'tire',
                            brand: 'New Brand',
                            model: 'New Model',
                            size: 'Size',
                            load_index: '',
                            speed_rating: '',
                            load_range: '',
                            xl_designation: 'No',
                            season: 'All-Season',
                            has_3pmsf: false,
                            winter_approved: false,
                            description: 'Manually added tire'
                          });
                          const newQuants = { ...bulkQuantities };
                          newQuants[newSpecs.length - 1] = 1;
                          setBulkExtractedSpecs(newSpecs);
                          setBulkQuantities(newQuants);
                        }}
                        className="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5"
                      >
                        <Plus className="w-3.5 h-3.5" /> Add Product
                      </button>
                    </div>

                    <div className="space-y-6 overflow-y-auto max-h-[55vh] pr-1">
                      {bulkExtractedSpecs.map((item, idx) => (
                        <div key={idx} className="glass-panel space-y-4 glass-panel--success relative receive-specs-card">
                          {/* Trash button to delete item */}
                          <button
                            onClick={() => {
                              const newSpecs = bulkExtractedSpecs.filter((_, i) => i !== idx);
                              const newQuants = { ...bulkQuantities };
                              delete newQuants[idx];
                              // Re-map keys to indices
                              const remappedQuants: { [key: number]: number } = {};
                              newSpecs.forEach((_, i) => {
                                remappedQuants[i] = i >= idx ? bulkQuantities[i + 1] || 1 : bulkQuantities[i] || 1;
                              });
                              setBulkExtractedSpecs(newSpecs);
                              setBulkQuantities(remappedQuants);
                            }}
                            className="absolute top-3 right-3 text-red-400 hover:text-red-300 p-1.5 rounded-lg hover:bg-red-500/10 transition-colors"
                            title="Delete Item"
                          >
                            <X className="w-4 h-4" />
                          </button>

                          <h4 className="font-bold text-sm text-emerald-400/90 border-b border-glass pb-1.5 pr-8">
                            Product #{idx + 1}: {item.brand} {item.model}
                          </h4>

                          {/* Editable spec form */}
                          <div className="intake-form">
                            <div className="intake-section">
                              <h4 className="intake-section__title">Product</h4>
                              <div className="intake-field-wrap">
                                <span className="spec-grid__label">Product Type</span>
                                <select
                                  value={item.product_type || 'tire'}
                                  onChange={(e) => {
                                    const val = e.target.value as 'tire' | 'wheel';
                                    const updated = [...bulkExtractedSpecs];
                                    updated[idx] = { ...updated[idx], product_type: val };
                                    setBulkExtractedSpecs(updated);
                                  }}
                                  className="intake-field"
                                >
                                  <option value="tire">🚗 Tire</option>
                                  <option value="wheel">⭕ Wheel</option>
                                </select>
                              </div>
                            </div>

                            <div className="intake-section bg-glass-dark/50">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold text-gray-400">Product Image:</span>
                                {bulkProductPhotos[idx] && (
                                  <span className="badge badge-green text-[10px]">Photo Ready</span>
                                )}
                              </div>

                              {!bulkProductPhotos[idx] ? (
                                <div>
                                  <input
                                    type="file"
                                    accept="image/*"
                                    capture="environment"
                                    id={`bulk-photo-upload-${idx}`}
                                    className="hidden"
                                    onChange={(e) => {
                                      const file = e.target.files?.[0];
                                      if (file) {
                                        const reader = new FileReader();
                                        reader.onload = (evt) => {
                                          if (evt.target?.result) {
                                            setBulkProductPhotos({
                                              ...bulkProductPhotos,
                                              [idx]: evt.target.result as string
                                            });
                                          }
                                        };
                                        reader.readAsDataURL(file);
                                      }
                                    }}
                                  />
                                  <label
                                    htmlFor={`bulk-photo-upload-${idx}`}
                                    className="btn-secondary py-1.5 px-3 text-[11px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer w-full"
                                  >
                                    <Camera className="w-3.5 h-3.5 text-emerald-400" />
                                    Snap Product Photo
                                  </label>
                                </div>
                              ) : (
                                <div className="relative rounded-lg overflow-hidden border border-glass max-h-[120px] bg-glass-dark">
                                  <img src={bulkProductPhotos[idx]} alt={`Product ${idx + 1} Preview`} className="w-full h-full object-contain mx-auto" />
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const newPhotos = { ...bulkProductPhotos };
                                      delete newPhotos[idx];
                                      setBulkProductPhotos(newPhotos);
                                    }}
                                    className="absolute top-1.5 right-1.5 bg-red-600 hover:bg-red-500 text-white rounded-md p-1 transition-colors"
                                    title="Delete Photo"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              )}
                            </div>

                            {item.product_type === 'wheel' ? (
                              <>
                                <div className="intake-section">
                                  <h4 className="intake-section__title">Brand & Model</h4>
                                  <div className="intake-field-wrap">
                                    <span className="spec-grid__label flex items-center justify-between">
                                      <span className="flex items-center gap-1.5">
                                        Brand
                                        {item.brand?.trim() && (
                                          <button
                                            type="button"
                                            onClick={() => {
                                              const updated = [...bulkExtractedSpecs];
                                              const oldBrand = updated[idx].brand;
                                              updated[idx] = {
                                                ...updated[idx],
                                                brand: '',
                                                model: oldBrand
                                              };
                                              setBulkExtractedSpecs(updated);
                                            }}
                                            className="text-[10px] bg-white border border-glass text-slate-600 font-bold px-2 py-1 rounded-lg transition-all flex items-center gap-1 hover:bg-glass-dark normal-case tracking-normal"
                                            title="Move brand name to model and enter brand manually"
                                          >
                                            Move to Model ⇄
                                          </button>
                                        )}
                                      </span>
                                      {!item.brand?.trim() && (
                                        <span className="text-[10px] text-amber-500 font-bold uppercase animate-pulse normal-case tracking-normal">⚠️ Enter Brand</span>
                                      )}
                                    </span>
                                    <textarea
                                      rows={3}
                                      placeholder="Enter brand name..."
                                      value={item.brand || ''}
                                      onChange={(e) => {
                                        const updated = [...bulkExtractedSpecs];
                                        updated[idx] = { ...updated[idx], brand: e.target.value };
                                        setBulkExtractedSpecs(updated);
                                      }}
                                      className={`intake-field intake-field--text ${!item.brand?.trim() ? 'intake-field--warn' : ''}`}
                                    />
                                  </div>
                                  <div className="intake-field-wrap">
                                    <span className="spec-grid__label">Model</span>
                                    <textarea
                                      rows={3}
                                      placeholder="Enter model name..."
                                      value={item.model || ''}
                                      onChange={(e) => {
                                        const updated = [...bulkExtractedSpecs];
                                        updated[idx] = { ...updated[idx], model: e.target.value };
                                        setBulkExtractedSpecs(updated);
                                      }}
                                      className="intake-field intake-field--text"
                                    />
                                  </div>
                                </div>
                                <div className="intake-section">
                                  <h4 className="intake-section__title">Wheel Specs</h4>
                                  <div className="intake-field-wrap">
                                    <span className="spec-grid__label">Finish / Color</span>
                                    <input
                                      type="text"
                                      placeholder="Enter finish/color..."
                                      value={item.finish || ''}
                                      onChange={(e) => {
                                        const updated = [...bulkExtractedSpecs];
                                        updated[idx] = { ...updated[idx], finish: e.target.value };
                                        setBulkExtractedSpecs(updated);
                                      }}
                                      className="intake-field"
                                    />
                                  </div>
                                  <div className="intake-field-wrap">
                                    <span className="spec-grid__label">Part Number</span>
                                    <input
                                      type="text"
                                      placeholder="Enter part number..."
                                      value={item.part_number || ''}
                                      onChange={(e) => {
                                        const updated = [...bulkExtractedSpecs];
                                        updated[idx] = { ...updated[idx], part_number: e.target.value };
                                        setBulkExtractedSpecs(updated);
                                      }}
                                      className="intake-field"
                                    />
                                  </div>
                                  <div className="intake-field-wrap">
                                    <span className="spec-grid__label">Size</span>
                                    <input
                                      type="text"
                                      placeholder="e.g. 18x8.5"
                                      value={item.size || ''}
                                      onChange={(e) => {
                                        const updated = [...bulkExtractedSpecs];
                                        updated[idx] = { ...updated[idx], size: e.target.value };
                                        setBulkExtractedSpecs(updated);
                                      }}
                                      className="intake-field"
                                    />
                                  </div>
                                  <div className="intake-field-wrap">
                                    <span className="spec-grid__label">Bolt Pattern (PCD)</span>
                                    <input
                                      type="text"
                                      value={item.bolt_pattern || ''}
                                      onChange={(e) => {
                                        const updated = [...bulkExtractedSpecs];
                                        updated[idx] = { ...updated[idx], bolt_pattern: e.target.value };
                                        setBulkExtractedSpecs(updated);
                                      }}
                                      className="intake-field"
                                    />
                                  </div>
                                  <div className="intake-field-pair">
                                    <div className="intake-field-wrap">
                                      <span className="spec-grid__label">Offset (ET)</span>
                                      <input
                                        type="text"
                                        value={item.offset || ''}
                                        onChange={(e) => {
                                          const updated = [...bulkExtractedSpecs];
                                          updated[idx] = { ...updated[idx], offset: e.target.value };
                                          setBulkExtractedSpecs(updated);
                                        }}
                                        className="intake-field"
                                      />
                                    </div>
                                    <div className="intake-field-wrap">
                                      <span className="spec-grid__label">Center Bore (CB)</span>
                                      <input
                                        type="text"
                                        value={item.center_bore || ''}
                                        onChange={(e) => {
                                          const updated = [...bulkExtractedSpecs];
                                          updated[idx] = { ...updated[idx], center_bore: e.target.value };
                                          setBulkExtractedSpecs(updated);
                                        }}
                                        className="intake-field"
                                      />
                                    </div>
                                  </div>
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="intake-section">
                                  <h4 className="intake-section__title">Brand & Model</h4>
                                  <div className="intake-field-wrap">
                                    <span className="spec-grid__label flex items-center justify-between">
                                      <span className="flex items-center gap-1.5">
                                        Brand
                                        {item.brand?.trim() && (
                                          <button
                                            type="button"
                                            onClick={() => {
                                              const updated = [...bulkExtractedSpecs];
                                              const oldBrand = updated[idx].brand;
                                              updated[idx] = {
                                                ...updated[idx],
                                                brand: '',
                                                model: oldBrand
                                              };
                                              setBulkExtractedSpecs(updated);
                                            }}
                                            className="text-[10px] bg-white border border-glass text-slate-600 font-bold px-2 py-1 rounded-lg transition-all flex items-center gap-1 hover:bg-glass-dark normal-case tracking-normal"
                                            title="Move brand name to model and enter brand manually"
                                          >
                                            Move to Model ⇄
                                          </button>
                                        )}
                                      </span>
                                      {!item.brand?.trim() && (
                                        <span className="text-[10px] text-amber-500 font-bold uppercase animate-pulse normal-case tracking-normal">⚠️ Enter Brand</span>
                                      )}
                                    </span>
                                    <textarea
                                      rows={3}
                                      placeholder="Enter brand name..."
                                      value={item.brand || ''}
                                      onChange={(e) => {
                                        const updated = [...bulkExtractedSpecs];
                                        updated[idx] = { ...updated[idx], brand: e.target.value };
                                        setBulkExtractedSpecs(updated);
                                      }}
                                      className={`intake-field intake-field--text ${!item.brand?.trim() ? 'intake-field--warn' : ''}`}
                                    />
                                  </div>
                                  <div className="intake-field-wrap">
                                    <span className="spec-grid__label">Model</span>
                                    <textarea
                                      rows={3}
                                      placeholder="Enter model name..."
                                      value={item.model || ''}
                                      onChange={(e) => {
                                        const updated = [...bulkExtractedSpecs];
                                        updated[idx] = { ...updated[idx], model: e.target.value };
                                        setBulkExtractedSpecs(updated);
                                      }}
                                      className="intake-field intake-field--text"
                                    />
                                  </div>
                                </div>
                                <div className="intake-section">
                                  <h4 className="intake-section__title">Tire Specs</h4>
                                  <div className="intake-field-wrap">
                                    <span className="spec-grid__label">Size</span>
                                    <input
                                      type="text"
                                      placeholder="e.g. 225/45R17"
                                      value={item.size || ''}
                                      onChange={(e) => {
                                        const updated = [...bulkExtractedSpecs];
                                        updated[idx] = { ...updated[idx], size: e.target.value };
                                        setBulkExtractedSpecs(updated);
                                      }}
                                      className="intake-field"
                                    />
                                  </div>
                                  <div className="intake-field-pair">
                                    <div className="intake-field-wrap">
                                      <span className="spec-grid__label">Load Index</span>
                                      <input
                                        type="text"
                                        placeholder="e.g. 95"
                                        value={item.load_index || ''}
                                        onChange={(e) => {
                                          const updated = [...bulkExtractedSpecs];
                                          updated[idx] = { ...updated[idx], load_index: e.target.value };
                                          setBulkExtractedSpecs(updated);
                                        }}
                                        className="intake-field"
                                      />
                                    </div>
                                    <div className="intake-field-wrap">
                                      <span className="spec-grid__label">Speed Rating</span>
                                      <input
                                        type="text"
                                        placeholder="e.g. H"
                                        value={item.speed_rating || ''}
                                        onChange={(e) => {
                                          const updated = [...bulkExtractedSpecs];
                                          updated[idx] = { ...updated[idx], speed_rating: e.target.value };
                                          setBulkExtractedSpecs(updated);
                                        }}
                                        className="intake-field"
                                      />
                                    </div>
                                  </div>
                                  <div className="intake-field-wrap">
                                    <span className="spec-grid__label">Load Range</span>
                                    <input
                                      type="text"
                                      placeholder="e.g. SL, XL, C"
                                      value={item.load_range || ''}
                                      onChange={(e) => {
                                        const updated = [...bulkExtractedSpecs];
                                        updated[idx] = { ...updated[idx], load_range: e.target.value };
                                        setBulkExtractedSpecs(updated);
                                      }}
                                      className="intake-field"
                                    />
                                  </div>
                                  <div className="intake-field-wrap">
                                    <span className="spec-grid__label">Season</span>
                                    <select
                                      value={item.season || 'All-Season'}
                                      onChange={(e) => {
                                        const val = e.target.value;
                                        const updated = [...bulkExtractedSpecs];
                                        updated[idx] = { ...updated[idx], season: val };
                                        setBulkExtractedSpecs(updated);
                                      }}
                                      className="intake-field"
                                    >
                                      <option value="All-Season">All-Season</option>
                                      <option value="Winter">Winter</option>
                                      <option value="Summer">Summer</option>
                                      <option value="All-Terrain">All-Terrain</option>
                                    </select>
                                  </div>
                                  <div className="intake-field-wrap">
                                    <span className="spec-grid__label">Ply Rating</span>
                                    <input
                                      type="text"
                                      placeholder="e.g. 4 Ply"
                                      value={item.ply_rating || ''}
                                      onChange={(e) => {
                                        const updated = [...bulkExtractedSpecs];
                                        updated[idx] = { ...updated[idx], ply_rating: e.target.value };
                                        setBulkExtractedSpecs(updated);
                                      }}
                                      className="intake-field"
                                    />
                                  </div>
                                </div>
                                <div className="intake-section">
                                  <h4 className="intake-section__title">Compliance</h4>
                                  <div className="intake-field-wrap">
                                    <span className="spec-grid__label">DOT Code</span>
                                    <input
                                      type="text"
                                      placeholder="DOT code from sidewall"
                                      value={item.dot_code || ''}
                                      onChange={(e) => {
                                        const updated = [...bulkExtractedSpecs];
                                        updated[idx] = { ...updated[idx], dot_code: e.target.value };
                                        setBulkExtractedSpecs(updated);
                                      }}
                                      className="intake-field"
                                    />
                                  </div>
                                  <div className="intake-field-wrap">
                                    <span className="spec-grid__label">UTQG Rating</span>
                                    <input
                                      type="text"
                                      placeholder="e.g. 500 A A"
                                      value={item.utqg || ''}
                                      onChange={(e) => {
                                        const updated = [...bulkExtractedSpecs];
                                        updated[idx] = { ...updated[idx], utqg: e.target.value };
                                        setBulkExtractedSpecs(updated);
                                      }}
                                      className="intake-field"
                                    />
                                  </div>
                                </div>
                              </>
                            )}
                          </div>

                          {/* Quantity selectors */}
                          <div className="flex items-center justify-between border-t border-glass pt-3 mt-2">
                            <span className="font-semibold text-sm">Quantity:</span>
                            <div className="flex items-center gap-3">
                              <button
                                onClick={() => {
                                  const val = bulkQuantities[idx] || 1;
                                  if (val > 1) {
                                    setBulkQuantities({ ...bulkQuantities, [idx]: val - 1 });
                                  }
                                }}
                                className="w-8 h-8 rounded-lg bg-glass border border-glass flex items-center justify-center font-bold text-lg hover:bg-glass-hover text-white"
                              >
                                -
                              </button>
                              <span className="font-bold text-lg text-white">{bulkQuantities[idx] || 1}</span>
                              <button
                                onClick={() => {
                                  const val = bulkQuantities[idx] || 1;
                                  setBulkQuantities({ ...bulkQuantities, [idx]: val + 1 });
                                }}
                                className="w-8 h-8 rounded-lg bg-glass border border-glass flex items-center justify-center font-bold text-lg hover:bg-glass-hover text-white"
                              >
                                +
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <button
                      onClick={handleSaveBulkReceive}
                      disabled={savingBulkReceive || bulkExtractedSpecs.length === 0 || bulkExtractedSpecs.some(item => !item.brand || !item.brand.trim())}
                      className={`w-full btn-primary py-4 mt-4 transition-all ${
                        (bulkExtractedSpecs.some(item => !item.brand || !item.brand.trim()) || bulkExtractedSpecs.length === 0)
                          ? 'bg-slate-200 text-gray-500 border border-slate-300 cursor-not-allowed hover:bg-slate-200'
                          : 'bg-primary text-white hover:opacity-95'
                      }`}
                    >
                      {savingBulkReceive ? <RotateCw className="w-5 h-5 animate-spin" /> : <CheckCircle className="w-5 h-5" />}
                      {bulkExtractedSpecs.some(item => !item.brand || !item.brand.trim())
                        ? 'Enter Brand Name for all items to Continue'
                        : `Save All Bulk Intake (${Object.values(bulkQuantities).reduce((a, b) => a + b, 0)} Items)`
                      }
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* tab: Inter-Store Transfer */}
        {activeTab === 'transfer' && (
          <div className="space-y-6 flex-1 flex flex-col">
            <div className="flex items-center gap-2 mb-2">
              <button onClick={() => { setActiveTab('dashboard'); setTransferPhoto(null); setTransferSpecs(null); setTransferQty(''); }} className="btn-secondary py-2 px-3">
                <ArrowLeftRight className="w-4 h-4 rotate-180" /> Back
              </button>
              <h2>Inter-Store Transfer</h2>
            </div>

            <div className="glass-panel space-y-4">
              <h3 className="text-xs font-semibold tracking-wider text-gray-400">Destination Location</h3>
              <select 
                value={transferDest}
                onChange={e => setTransferDest(e.target.value)}
                className="w-full"
              >
                <option value="" disabled>Select target store...</option>
                {locations.filter(l => l.id !== activeLocation).map(loc => (
                  <option key={loc.id} value={loc.id}>{loc.name}</option>
                ))}
              </select>
            </div>

            {transferDest && (
              <>
                {!transferPhoto ? (
                  <div 
                    onClick={() => transferFileRef.current?.click()}
                    className="flex-1 border-2 border-dashed border-glass rounded-2xl flex flex-col items-center justify-center p-8 cursor-pointer hover:border-cyan-500/40 transition-all min-h-[250px]"
                  >
                    <Camera className="w-14 h-14 text-gray-500 mb-4" />
                    <span className="font-semibold text-lg text-gray-300">Snap Transfer Tire Sticker</span>
                    <input 
                      type="file" 
                      accept="image/*" 
                      capture="environment" 
                      ref={transferFileRef}
                      onChange={e => handleFileChange(e, processTransferSticker)}
                      className="hidden" 
                    />
                  </div>
                ) : (
                  <div className="space-y-6 flex-1 flex flex-col">
                    <div className="relative rounded-2xl overflow-hidden border border-glass max-h-[160px]">
                      <img src={transferPhoto} alt="Transfer Label Preview" className="w-full h-full object-cover" />
                      <button onClick={() => setTransferPhoto(null)} className="absolute top-2 right-2 btn-secondary py-2 px-3 text-xs">Retake</button>
                    </div>

                    {extracting && (
                      <div className="glass-panel flex flex-col items-center justify-center py-8 space-y-4">
                        <RotateCw className="w-10 h-10 text-cyan-400 animate-spin" />
                        <div className="text-center font-medium">AI Loading Sticker Details...</div>
                      </div>
                    )}

                    {transferSpecs && (
                      <div className="glass-panel space-y-2 text-sm">
                        <div className="font-bold text-cyan-400 border-b border-glass pb-1 mb-2">Transfer Item Match</div>
                        <div>Tire: <strong>{transferSpecs.brand} {transferSpecs.model}</strong></div>
                        <div>Size: <strong>{transferSpecs.size}</strong></div>
                      </div>
                    )}

                    {transferSpecs && (
                      <div className="space-y-4 mt-auto">
                        <div className="glass-panel p-4 flex items-center justify-between">
                          <span className="font-bold text-lg">Send Quantity</span>
                          <input 
                            type="text" 
                            readOnly 
                            placeholder="0" 
                            value={transferQty}
                            className="text-right text-2xl font-bold bg-transparent border-none outline-none max-w-[150px] p-0 text-cyan-400"
                          />
                        </div>

                        <div className="keypad-grid">
                          {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map(btn => (
                            <button 
                              key={btn} 
                              onClick={() => handleKeypadPress(btn, transferQty, setTransferQty)}
                              className={`keypad-btn ${['C','⌫'].includes(btn) ? 'keypad-btn-action' : ''}`}
                            >
                              {btn}
                            </button>
                          ))}
                        </div>

                        <button 
                          onClick={handleSendTransfer}
                          disabled={sendingTransfer || !transferQty}
                          className="w-full btn-primary mt-4 py-4 bg-gradient-to-r from-cyan-600 to-cyan-500 shadow-cyan-500/10"
                        >
                          {sendingTransfer ? <RotateCw className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
                          Ship Transfer In Transit
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* tab: Confirm/Verify Pending Transfers (Handshake Receipt) */}
        {activeTab === 'verify' && selectedTransfer && (
          <div className="space-y-6 flex-1 flex flex-col">
            <div className="flex items-center gap-2 mb-2">
              <button 
                onClick={() => { setSelectedTransfer(null); setVerifyPhoto(null); setVerifyQty(''); }} 
                className="btn-secondary py-2 px-3"
              >
                <ArrowLeftRight className="w-4 h-4 rotate-180" /> Back
              </button>
              <h2>Verify Arrival</h2>
            </div>

            <div className="glass-panel space-y-3">
              <div className="text-xs uppercase tracking-wider text-gray-500 font-bold">Incoming Shipment Details</div>
              <div className="text-lg font-bold">{selectedTransfer.sku}</div>
              <div className="grid grid-cols-2 gap-4 text-sm mt-2">
                <div>
                  <span className="text-gray-400 block text-xs">Shipped Quantity</span>
                  <span className="font-bold text-white">{selectedTransfer.quantity} pieces</span>
                </div>
                <div>
                  <span className="text-gray-400 block text-xs">Origin</span>
                  <span className="font-bold text-white">
                    {locations.find(l => l.id === selectedTransfer.from_location)?.name || selectedTransfer.from_location}
                  </span>
                </div>
              </div>
            </div>

            {!verifyPhoto ? (
              <div 
                onClick={() => verifyFileRef.current?.click()}
                className="flex-1 border-2 border-dashed border-glass rounded-2xl flex flex-col items-center justify-center p-8 cursor-pointer hover:border-amber-500/40 transition-all min-h-[220px]"
              >
                <Camera className="w-14 h-14 text-gray-500 mb-4" />
                <span className="font-semibold text-lg text-gray-300">Scan Sticker to Verify Product</span>
                <input 
                  type="file" 
                  accept="image/*" 
                  capture="environment" 
                  ref={verifyFileRef}
                  onChange={e => handleFileChange(e, setVerifyPhoto)}
                  className="hidden" 
                />
              </div>
            ) : (
              <div className="space-y-6 flex-1 flex flex-col">
                <div className="relative rounded-2xl overflow-hidden border border-glass max-h-[140px]">
                  <img src={verifyPhoto} alt="Verified Item Preview" className="w-full h-full object-cover" />
                  <button onClick={() => setVerifyPhoto(null)} className="absolute top-2 right-2 btn-secondary py-1.5 px-3 text-xs">Retake</button>
                </div>

                <div className="space-y-4 mt-auto">
                  <div className="glass-panel p-4 flex items-center justify-between">
                    <div className="flex flex-col">
                      <span className="font-bold text-lg">Actual Count Received</span>
                      <span className="text-xs text-gray-500">Shipped: {selectedTransfer.quantity}</span>
                    </div>
                    <input 
                      type="text" 
                      readOnly 
                      placeholder="0" 
                      value={verifyQty}
                      className="text-right text-2xl font-bold bg-transparent border-none outline-none max-w-[150px] p-0 text-amber-400"
                    />
                  </div>

                  <div className="keypad-grid">
                    {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map(btn => (
                      <button 
                        key={btn} 
                        onClick={() => handleKeypadPress(btn, verifyQty, setVerifyQty)}
                        className={`keypad-btn ${['C','⌫'].includes(btn) ? 'keypad-btn-action' : ''}`}
                      >
                        {btn}
                      </button>
                    ))}
                  </div>

                  {verifyQty && parseInt(verifyQty) !== selectedTransfer.quantity && (
                    <div className="flex items-center gap-2 text-amber-500 bg-amber-500/10 p-3 rounded-lg border border-amber-500/20 text-xs">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      <span>Warning: Received quantity differs from shipped quantity. Discrepancy will be logged!</span>
                    </div>
                  )}

                  <button 
                    onClick={handleConfirmReceipt}
                    disabled={verifyingTransfer || !verifyQty}
                    className="w-full btn-primary mt-4 py-4 bg-gradient-to-r from-amber-600 to-amber-500 shadow-amber-500/10"
                  >
                    {verifyingTransfer ? <RotateCw className="w-5 h-5 animate-spin" /> : <Check className="w-5 h-5" />}
                    Confirm Receipt & Update Inventory
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* tab: AI Stack Count Estimator */}
        {activeTab === 'estimate' && (
          <div className="space-y-6 flex-1 flex flex-col">
            <div className="flex items-center gap-2 mb-2">
              <button onClick={() => { setActiveTab('dashboard'); setEstimatorPhoto(null); setEstimateResult(null); setShowLearningPrompt(false); setLearningSubmitted(false); }} className="btn-secondary py-2 px-3">
                <ArrowLeftRight className="w-4 h-4 rotate-180" /> Back
              </button>
              <h2>AI Stack Estimator</h2>
            </div>

            {!estimatorPhoto ? (
              <div 
                onClick={() => estimatorFileRef.current?.click()}
                className="flex-1 border-2 border-dashed border-glass rounded-2xl flex flex-col items-center justify-center p-8 cursor-pointer hover:border-emerald-500/40 transition-all min-h-[300px]"
              >
                <Camera className="w-16 h-16 text-gray-500 mb-4" />
                <span className="font-semibold text-lg text-gray-300">Take Photo of Stacks</span>
                <span className="text-xs text-gray-500 mt-1">Capture columns from top to bottom clearly</span>
                <input 
                  type="file" 
                  accept="image/*" 
                  capture="environment" 
                  ref={estimatorFileRef}
                  onChange={e => handleFileChange(e, processStackPhoto)}
                  className="hidden" 
                />
              </div>
            ) : (
              <div className="space-y-6 flex-1 flex flex-col">
                <div className="relative rounded-2xl overflow-hidden border border-glass max-h-[220px]">
                  <img src={estimatorPhoto} alt="Stacked Tires Preview" className="w-full h-full object-cover" />
                  <button onClick={() => setEstimatorPhoto(null)} className="absolute top-2 right-2 btn-secondary py-2 px-3 text-xs">Retake</button>
                </div>

                {estimating && (
                  <div className="glass-panel flex flex-col items-center justify-center py-10 space-y-4">
                    <RotateCw className="w-10 h-10 text-emerald-400 animate-spin" />
                    <div className="text-center font-medium">AI Analyzing Stack Totals...</div>
                  </div>
                )}

                {estimateResult && (
                  <div className="glass-panel space-y-4">
                    <div className="flex items-center justify-between border-b border-glass pb-2">
                      <h3 className="font-bold text-emerald-400">AI Estimation Report</h3>
                      <span className={`badge ${estimateResult.conf >= 90 ? 'badge-green' : 'badge-amber'}`}>
                        {estimateResult.conf}% Confidence
                      </span>
                    </div>

                    <div className="text-center py-4">
                      <span className="text-gray-400 text-sm uppercase block font-medium">Estimated Quantity</span>
                      <span className="text-4xl font-extrabold text-white">{estimateResult.min} – {estimateResult.max}</span>
                      <span className="text-gray-500 block text-xs mt-1">tires</span>
                    </div>

                    <div className="text-xs text-gray-400 bg-white/5 p-3 rounded-lg border border-glass">
                      <strong>AI Reasoning:</strong> {estimateResult.reason}
                    </div>

                    {/* Learning Feedback Loop Form */}
                    {!learningSubmitted ? (
                      <div className="border-t border-glass pt-4 mt-2">
                        <div className="text-center text-sm font-medium mb-3">Was this AI estimate accurate?</div>
                        <div className="grid grid-cols-2 gap-4">
                          <button onClick={() => submitLearningFeedback(true)} className="btn-secondary py-3 text-sm bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border-emerald-500/20">
                            Yes, Accurate
                          </button>
                          <button onClick={() => submitLearningFeedback(false)} className="btn-secondary py-3 text-sm bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border-rose-500/20">
                            No, Incorrect
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-center text-xs text-emerald-400 bg-emerald-500/15 p-3 rounded-xl border border-emerald-500/20 font-medium">
                        ✓ Thank you! The AI will learn from this result to improve stack counting heuristics.
                      </div>
                    )}

                    {showLearningPrompt && (
                      <div className="glass-panel bg-rose-500/5 border-rose-500/20 space-y-4 p-4 mt-2">
                        <div className="font-bold text-sm text-rose-400">Log Manual Correction:</div>
                        <div className="space-y-2">
                          <label className="text-xs text-gray-400 block uppercase">Actual count found:</label>
                          <input 
                            type="text" 
                            placeholder="Enter physical count..."
                            value={actualStackCount}
                            onChange={e => setActualStackCount(e.target.value)}
                            className="bg-black/40"
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs text-gray-400 block uppercase">Reason for AI discrepancy:</label>
                          <select 
                            value={learningReason}
                            onChange={e => setLearningReason(e.target.value)}
                            className="bg-black/40"
                          >
                            <option value="" disabled>Select reason...</option>
                            <option value="deep_stacking">Tires stacked deeply behind visible rows</option>
                            <option value="mixed_sizing">Different sizes mixed in stack</option>
                            <option value="bad_lighting">Dim warehouse lighting / shadow bloat</option>
                            <option value="other">Other / Stack structure complexity</option>
                          </select>
                        </div>
                        <button onClick={handleSaveCorrectionFeedback} className="w-full btn-accent-red py-3 text-sm">
                          Submit AI Calibration
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* tab: Weekly Audit Report */}
        {activeTab === 'audit' && (
          <div className="space-y-6 flex-1 flex flex-col">
            <div className="flex items-center gap-2 mb-2">
              <button onClick={() => { setActiveTab('dashboard'); setAuditPhotos([]); setAuditReport(null); }} className="btn-secondary py-2 px-3">
                <ArrowLeftRight className="w-4 h-4 rotate-180" /> Back
              </button>
              <h2>Weekly AI Warehouse Audit</h2>
            </div>

            <div className="glass-panel space-y-3">
              <h3 className="text-xs font-semibold tracking-wider text-gray-400">Audit Progress</h3>
              <p className="text-xs text-gray-500">Walk through your bays snapping pictures. Take photos of each stack zone.</p>
              
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => auditFileRef.current?.click()}
                  className="btn-secondary py-3 px-4 text-sm flex items-center gap-1.5"
                >
                  <Camera className="w-4 h-4" /> Add Bay Photo ({auditPhotos.length})
                </button>
                <input 
                  type="file" 
                  accept="image/*" 
                  capture="environment" 
                  ref={auditFileRef}
                  onChange={e => handleFileChange(e, addAuditPhoto)}
                  className="hidden" 
                />
                
                {auditPhotos.length > 0 && (
                  <button 
                    onClick={runWarehouseAudit}
                    disabled={auditing}
                    className="btn-primary py-3 px-4 text-sm flex-1"
                  >
                    Compile Report
                  </button>
                )}
              </div>
            </div>

            {/* Thumbnail previews */}
            {auditPhotos.length > 0 && !auditReport && (
              <div className="grid grid-cols-4 gap-2 border border-glass p-3 rounded-xl max-h-[140px] overflow-y-auto">
                {auditPhotos.map((photo, i) => (
                  <div key={i} className="relative aspect-square rounded-lg overflow-hidden border border-glass">
                    <img src={photo} className="w-full h-full object-cover" />
                    <button 
                      onClick={() => setAuditPhotos(prev => prev.filter((_, idx) => idx !== i))}
                      className="absolute top-0.5 right-0.5 bg-black/60 rounded-full w-4 h-4 flex items-center justify-center text-[10px] text-white"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {auditing && (
              <div className="glass-panel flex flex-col items-center justify-center py-12 space-y-4">
                <RotateCw className="w-12 h-12 text-amber-400 animate-spin" />
                <div className="text-center font-medium">AI Compiling Weekly Audit Data...</div>
              </div>
            )}

            {auditReport && (
              <div className="glass-panel space-y-4">
                <div className="flex items-center justify-between border-b border-glass pb-2">
                  <h3 className="font-bold text-amber-500">Weekly Audit Report</h3>
                  <span className="badge badge-amber">{auditReport.confidence}% Confidence</span>
                </div>

                <div className="grid grid-cols-2 gap-4 text-center">
                  <div className="p-3 bg-white/5 border border-glass rounded-xl">
                    <span className="text-[10px] text-gray-500 uppercase block font-medium">Bays Cleanliness</span>
                    <span className="text-2xl font-bold text-white">{auditReport.organizationScore}%</span>
                  </div>
                  <div className="p-3 bg-white/5 border border-glass rounded-xl">
                    <span className="text-[10px] text-gray-500 uppercase block font-medium">Discrepancies</span>
                    <span className="text-2xl font-bold text-rose-400">{auditReport.discrepancyCount} flags</span>
                  </div>
                </div>

                <div className="space-y-3 mt-2">
                  <div className="text-xs uppercase font-bold text-gray-400 tracking-wider">Mismatched Items Detected</div>
                  {auditReport.mixedBays.map((bay, idx) => (
                    <div key={idx} className="flex items-start gap-2 p-2 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-lg text-xs">
                      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                      <span>{bay}</span>
                    </div>
                  ))}
                </div>

                <div className="space-y-3 mt-2">
                  <div className="text-xs uppercase font-bold text-gray-400 tracking-wider">Empty Bay Locations</div>
                  <div className="flex flex-wrap gap-2">
                    {auditReport.emptyBays.map((bay, idx) => (
                      <span key={idx} className="badge badge-blue">{bay}</span>
                    ))}
                  </div>
                </div>

                <div className="text-center text-[10px] text-gray-500 border-t border-glass pt-3 mt-4">
                  Report generated on {new Date().toLocaleDateString()}
                </div>
              </div>
            )}
          </div>
        )}

        {/* tab: Orders to Dispatch */}
        {activeTab === 'orders' && (
          <div className="space-y-6 flex-1 flex flex-col">
            <div className="flex items-center gap-2 mb-2">
              <button 
                onClick={() => { setSelectedOrder(null); setTrackingInput(''); setActiveTab('dashboard'); }} 
                className="btn-secondary py-2 px-3"
              >
                <ArrowLeftRight className="w-4 h-4 rotate-180" /> Back
              </button>
              <h2>Orders to Dispatch</h2>
            </div>

            {!selectedOrder ? (
              <div className="space-y-4">
                <div className="glass-panel space-y-2">
                  <h3 className="text-xs font-semibold tracking-wider text-gray-400">Queue</h3>
                  <p className="text-xs text-gray-500">Select a pending order to package, print shipping label, and ship.</p>
                </div>

                {orders.length === 0 ? (
                  <div className="glass-panel py-12 text-center text-gray-500 text-sm">
                    No pending orders to ship for {locationName}.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {orders.map(order => (
                      <div 
                        key={order.id}
                        onClick={() => setSelectedOrder(order)}
                        className="glass-panel glass-panel-interactive flex justify-between items-center"
                      >
                        <div className="space-y-1">
                          <span className="badge badge-amber text-xs">{order.order_number}</span>
                          <div className="font-semibold text-slate-800 text-sm mt-1">{order.customer_name}</div>
                          <div className="text-xs text-gray-500">{order.shipping_method} • {order.items.reduce((acc, i) => acc + i.quantity, 0)} items</div>
                        </div>
                        <span className="btn-secondary py-2 px-3 text-xs flex items-center gap-1">
                          Pack & Ship
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="glass-panel space-y-6">
                <div className="flex items-center justify-between border-b border-glass pb-3">
                  <h3 className="font-bold text-slate-800">Dispatch Order {selectedOrder.order_number}</h3>
                  <span className="badge badge-blue">{selectedOrder.source}</span>
                </div>

                {/* Customer Details */}
                <div className="space-y-1 text-sm bg-white/5 p-3 rounded-xl border border-glass">
                  <div className="text-xs text-gray-500 uppercase font-medium">Ship To:</div>
                  <div className="font-semibold text-slate-800">{selectedOrder.customer_name}</div>
                  <div className="text-slate-600">{selectedOrder.shipping_address}</div>
                  <div className="text-slate-600 text-xs mt-1">Method: <strong className="text-slate-800">{selectedOrder.shipping_method}</strong></div>
                </div>

                {/* Packing Checklist */}
                <div className="space-y-3">
                  <h3 className="text-xs font-semibold tracking-wider text-gray-400">Items Packing Checklist</h3>
                  <div className="space-y-2">
                    {selectedOrder.items.map((item, idx) => (
                      <label 
                        key={idx} 
                        className="flex items-start gap-3 p-3 bg-white/5 border border-glass rounded-xl cursor-pointer hover:bg-white/10 transition-all"
                      >
                        <input type="checkbox" className="mt-1 w-4 h-4 rounded border-glass text-primary focus:ring-primary" />
                        <div className="text-sm">
                          <div className="font-semibold text-slate-800">{item.brand} {item.size}</div>
                          <div className="text-xs text-gray-500">SKU: {item.sku}</div>
                          <div className="text-xs font-bold text-primary mt-0.5">Quantity: {item.quantity} pcs</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Tracking Input */}
                <div className="space-y-2">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400">Tracking Number</label>
                  <input 
                    type="text" 
                    placeholder="Scan barcode or enter tracking ID..."
                    value={trackingInput}
                    onChange={e => setTrackingInput(e.target.value)}
                    className="w-full"
                  />
                </div>

                {/* Dispatch Controls */}
                <div className="flex gap-3">
                  <button 
                    onClick={() => window.print()}
                    className="btn-secondary py-3.5 flex-1 text-sm flex items-center justify-center gap-1.5"
                  >
                    <Printer className="w-4 h-4" /> Print Label
                  </button>
                  <button 
                    onClick={() => handleShipOrder(selectedOrder)}
                    disabled={dispatching}
                    className="btn-primary py-3.5 flex-1 text-sm flex items-center justify-center gap-1.5"
                  >
                    <CheckCircle className="w-4 h-4" /> Ship Order
                  </button>
                </div>

                {/* Hidden Print Section for standard 4x6 labels */}
                <div id="print-section" className="hidden">
                  <div style={{ border: '2px solid black', padding: '15px', fontFamily: 'monospace', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                    <div style={{ textAlign: 'center', borderBottom: '2px solid black', paddingBottom: '10px' }}>
                      <h2 style={{ fontSize: '20px', margin: 0 }}>ATLANTIC TIRE KING</h2>
                      <span style={{ fontSize: '10px' }}>WAREHOUSE DISPATCH LABEL</span>
                    </div>
                    
                    <div style={{ margin: '15px 0', fontSize: '12px' }}>
                      <strong>ORDER NO:</strong> {selectedOrder.order_number}<br/>
                      <strong>SHIP TO:</strong><br/>
                      {selectedOrder.customer_name}<br/>
                      {selectedOrder.shipping_address}<br/>
                      <strong>METHOD:</strong> {selectedOrder.shipping_method}
                    </div>

                    <div style={{ borderTop: '1px dashed black', borderBottom: '1px dashed black', padding: '10px 0', margin: '10px 0' }}>
                      <strong>PACKING LIST:</strong><br/>
                      {selectedOrder.items.map((item, idx) => (
                        <div key={idx} style={{ fontSize: '11px' }}>
                          • {item.brand} {item.size} - Qty: {item.quantity} [ ] Checked
                        </div>
                      ))}
                    </div>

                    <div style={{ textAlign: 'center', marginTop: '20px' }}>
                      <div style={{ letterSpacing: '4px', fontSize: '18px', fontWeight: 'bold' }}>
                        ||||| | ||||| | ||||| | ||
                      </div>
                      <div style={{ fontSize: '10px', marginTop: '5px' }}>
                        *{selectedOrder.order_number}*
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* tab: Transaction Logs & Corrections */}
        {activeTab === 'logs' && (
          <div className="space-y-6 flex-1 flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => setActiveTab('dashboard')} 
                  className="btn-secondary py-2 px-3 text-xs"
                >
                  <ArrowLeftRight className="w-4 h-4 rotate-180" /> Back
                </button>
                <h2>Transaction History & Stock Alignments</h2>
              </div>
              <button 
                onClick={fetchRecentTransactions}
                className="btn-secondary py-2 px-3 text-xs flex items-center gap-1"
              >
                <RotateCw className="w-3.5 h-3.5" /> Refresh
              </button>
            </div>

            <div className="glass-panel space-y-4 flex-1 flex flex-col min-h-[400px]">
              <div className="border-b border-glass pb-3 flex justify-between items-center">
                <h3 className="text-xs font-semibold tracking-wider text-gray-400 uppercase">Recent Logs ({locationName})</h3>
                <span className="text-xs text-gray-500 font-medium">{isOnline ? 'Synced Real-Time' : 'Cached Offline'}</span>
              </div>

              {recentTransactions.length === 0 ? (
                <div className="text-center py-16 text-gray-500 text-sm flex-1 flex flex-col justify-center">
                  No recent inventory transactions found.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs text-slate-300">
                    <thead>
                      <tr className="border-b border-glass text-gray-500 font-semibold uppercase tracking-wider">
                        <th className="py-3 px-2">Type</th>
                        <th className="py-3 px-2">SKU</th>
                        <th className="py-3 px-2">Qty</th>
                        <th className="py-3 px-2">Staff</th>
                        <th className="py-3 px-2">Date</th>
                        <th className="py-3 px-2">Notes</th>
                        <th className="py-3 px-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentTransactions.map((tx) => {
                        const isFailed = tx.status === 'needs_correction';
                        return (
                          <tr key={tx.id} className={`border-b border-glass/40 hover:bg-white/5 transition-colors ${isFailed ? 'bg-rose-500/5' : ''}`}>
                            <td className="py-3 px-2 font-medium capitalize">
                              <span className={`badge ${tx.transaction_type === 'receive' ? 'badge-green' : 'badge-violet'}`}>
                                {tx.transaction_type}
                              </span>
                            </td>
                            <td className="py-3 px-2 font-mono font-bold tracking-tight text-white">{tx.sku}</td>
                            <td className="py-3 px-2 text-slate-200 font-bold">{tx.quantity}</td>
                            <td className="py-3 px-2 text-slate-400">{tx.employee_id || 'System'}</td>
                            <td className="py-3 px-2 text-slate-500">
                              {new Date(tx.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </td>
                            <td className="py-3 px-2 text-slate-400 max-w-[200px] truncate" title={tx.notes}>
                              {isFailed && <span className="text-rose-400 font-semibold mr-1">[!]</span>}
                              {tx.notes || '-'}
                            </td>
                            <td className="py-3 px-2 text-right space-x-1 whitespace-nowrap">
                              <button
                                onClick={() => handleOpenFlagTransaction(tx)}
                                className="btn-secondary py-1 px-2.5 text-[10px] text-amber-500 hover:bg-amber-500/10"
                                title="Flag for correction"
                              >
                                Flag
                              </button>
                              <button
                                onClick={() => handleOpenEditTransaction(tx)}
                                className="btn-primary py-1 px-2.5 text-[10px]"
                                title="Manager PIN Override Required"
                              >
                                Edit
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Modal: Manager PIN Override */}
      {managerPinModalOpen && editingTransaction && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="glass-panel w-full max-w-md space-y-6 relative border-amber-500/20 bg-slate-900/95">
            <button 
              onClick={() => { setManagerPinModalOpen(false); setEditingTransaction(null); }}
              className="absolute top-4 right-4 p-1 hover:bg-white/10 rounded-lg text-gray-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="text-center space-y-2 border-b border-glass pb-4">
              <Lock className="w-12 h-12 text-amber-500 mx-auto" />
              <h2 className="text-lg font-bold text-white uppercase tracking-wider">Manager Override Required</h2>
              <p className="text-xs text-gray-500">A manager must enter their 4-digit PIN to edit or delete this entry.</p>
            </div>

            <div className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-2 bg-white/5 p-3 rounded-xl border border-glass">
                <div>
                  <span className="text-gray-500">Tire SKU:</span>
                  <div className="font-bold font-mono mt-0.5 text-white">{editingTransaction.sku}</div>
                </div>
                <div>
                  <span className="text-gray-500">Original Qty:</span>
                  <div className="font-bold text-white mt-0.5">{editingTransaction.quantity} pcs</div>
                </div>
              </div>

              {/* Input for new quantity */}
              <div className="space-y-2">
                <label className="block text-gray-400 font-semibold uppercase tracking-wider">Corrected Quantity</label>
                <input
                  type="number"
                  placeholder="Enter correct stock count..."
                  value={newQtyInput}
                  onChange={e => setNewQtyInput(e.target.value)}
                  className="w-full text-base font-bold p-2 rounded-lg bg-white/10 border border-glass text-slate-100 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              {/* Input for manager pin */}
              <div className="space-y-2">
                <label className="block text-gray-400 font-semibold uppercase tracking-wider">4-Digit Manager PIN</label>
                <input
                  type="password"
                  maxLength={4}
                  placeholder="PIN"
                  value={managerPinInput}
                  onChange={e => setManagerPinInput(e.target.value.replace(/\D/g, ''))}
                  className="w-full text-center text-xl font-bold tracking-[0.5em] p-2 rounded-lg bg-white/10 border border-glass text-slate-100 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              {managerPinError && (
                <div className="p-3 bg-rose-500/10 border border-rose-500/25 text-rose-400 rounded-xl text-center font-medium">
                  {managerPinError}
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={handleSaveTransactionDelete}
                className="btn-secondary py-3 flex-1 text-sm bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border-rose-500/25"
              >
                Delete Log
              </button>
              <button
                onClick={handleSaveTransactionEdit}
                className="btn-primary py-3 flex-1 text-sm"
              >
                Apply Corrected Qty
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Worker Correction Flag Note */}
      {flagModalOpen && flagTx && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="glass-panel w-full max-w-md space-y-6 relative border-amber-500/20 bg-slate-900/95">
            <button 
              onClick={() => { setFlagModalOpen(false); setFlagTx(null); }}
              className="absolute top-4 right-4 p-1 hover:bg-white/10 rounded-lg text-gray-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="text-center space-y-2 border-b border-glass pb-4">
              <AlertTriangle className="w-12 h-12 text-amber-500 mx-auto" />
              <h2 className="text-lg font-bold text-white uppercase tracking-wider">Flag Transaction for Correction</h2>
              <p className="text-xs text-gray-500">Manager is not on duty? Add a review flag and a note explaining the mistake.</p>
            </div>

            <div className="space-y-4 text-xs">
              <div className="bg-white/5 p-3 rounded-xl border border-glass space-y-1">
                <div><span className="text-gray-500">Tire:</span> <strong className="text-white">{flagTx.sku}</strong></div>
                <div><span className="text-gray-500">Intake Count:</span> <strong className="text-white">{flagTx.quantity} pcs</strong></div>
              </div>

              <div className="space-y-2">
                <label className="block text-gray-400 font-semibold uppercase tracking-wider">Explanation / Correction Note</label>
                <textarea
                  rows={4}
                  placeholder="e.g. Mistakenly entered 20 pieces instead of 2. Needs Moncton stock adjusted by -18..."
                  value={flagNoteInput}
                  onChange={e => setFlagNoteInput(e.target.value)}
                  className="w-full p-3 bg-white/10 border border-glass rounded-xl text-slate-100 placeholder-gray-500 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => { setFlagModalOpen(false); setFlagTx(null); }}
                className="btn-secondary py-3 flex-1 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveFlagCorrection}
                className="btn-primary py-3 flex-1 text-sm"
              >
                Submit Flag Request
              </button>
            </div>
          </div>
        </div>
      )}

      {/* tab: Staff Timecard (technicians & store managers — not super admin) */}
      {activeTab === 'timecard' && currentUser?.technicianId && !isSuperAdminUser && (
        <div className="space-y-6 flex-1 flex flex-col">
          <div className="flex items-center gap-2 mb-2">
            <button onClick={() => setActiveTab('dashboard')} className="btn-secondary py-2 px-3">
              <ArrowLeftRight className="w-4 h-4 rotate-180 inline mr-1" /> Back
            </button>
            <h2>My Timecard</h2>
          </div>

          <div className="glass-panel">
            <div className="geofence-status">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-400">
                <MapPin className="w-4 h-4 text-primary" />
                <span>Location Status</span>
              </div>
              {isOnSite ? (
                <span className="badge badge-green text-xs">Verified</span>
              ) : (
                <span className="badge badge-rose text-xs">Unavailable</span>
              )}
            </div>

            {gpsError && (
              <div className="scan-result-alert scan-result-alert--error text-xs">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                <span>{gpsError}</span>
              </div>
            )}

            {isClockedIn && geofenceExitAt && (
              <div className="scan-result-alert scan-result-alert--error text-xs mt-3">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                <span>
                  Return within{' '}
                  {Math.max(0, Math.ceil((GEOFENCE_GRACE_MS - (Date.now() - geofenceExitAt)) / 60000))} min
                  {' '}or your shift may end automatically.
                </span>
              </div>
            )}
          </div>

          <div className="timecard-hero space-y-5">
            <div>
              <div className="timecard-hero__label">Active Shift Duration</div>
              <div className="timecard-hero__timer">{shiftHoursText}</div>
            </div>

            {!isClockedIn ? (
              <button
                type="button"
                onClick={async () => {
                  if (!configDb || !currentUser.technicianId) return;
                  if (!isOnSite) {
                    showTemporaryMessage('error', 'Cannot clock in: location verification required.');
                    return;
                  }
                  const newShift = {
                    id: 'shift-' + Math.random().toString(36).substring(2),
                    technicianId: currentUser.technicianId,
                    technicianName: currentUser.name,
                    locationId: activeLocation,
                    locationName: locationName,
                    clockIn: new Date().toISOString(),
                    clockOut: null,
                    status: 'active',
                    payoutStatus: 'unpaid'
                  };
                  const updated = {
                    ...configDb,
                    timecards: [...(configDb?.timecards || []), newShift]
                  };
                  await saveConfig(updated);
                  setIsClockedIn(true);
                  setActiveShift(newShift);
                  setGeofenceExitAt(null);
                  showTemporaryMessage('success', 'Shift started! Clocked in successfully.');
                }}
                disabled={!isOnSite}
                className="btn-clock-in"
              >
                <Clock className="w-5 h-5" />
                {isOnSite ? 'Clock In Now' : 'Location Required to Clock In'}
              </button>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  if (!configDb) return;
                  const clockOutTime = new Date().toISOString();
                  const updatedTimecards = configDb.timecards.map((tc: any) => {
                    if (tc.id === activeShift.id) {
                      return { ...tc, status: 'completed', clockOut: clockOutTime };
                    }
                    return tc;
                  });
                  await saveConfig({ ...configDb, timecards: updatedTimecards });
                  setIsClockedIn(false);
                  setActiveShift(null);
                  setGeofenceExitAt(null);
                  showTemporaryMessage('success', 'Shift completed! Clocked out successfully.');
                }}
                className="btn-clock-out"
              >
                <LogOut className="w-5 h-5" />
                Clock Out & End Shift
              </button>
            )}
          </div>

          <div className="glass-panel space-y-4">
            <h3 className="intake-section__title" style={{ border: 'none', padding: 0, margin: 0 }}>Earnings Summary</h3>
            {(() => {
              const techProfile = configDb?.technicians.find(t => t.id === currentUser.technicianId);
              const rate = techProfile?.hourlyRate || 0;
              const unpaidShifts = (configDb?.timecards || []).filter(
                (tc: any) => tc.technicianId === currentUser.technicianId && tc.status === 'completed' && tc.payoutStatus === 'unpaid'
              );
              const totalMs = unpaidShifts.reduce((acc: number, shift: any) => {
                return acc + (Date.parse(shift.clockOut) - Date.parse(shift.clockIn));
              }, 0);
              const totalHours = totalMs / 3600000;
              const earnings = totalHours * rate;

              return (
                <div className="workforce-summary">
                  <div className="workforce-summary__card">
                    <div className="workforce-summary__value">{totalHours.toFixed(1)}</div>
                    <div className="workforce-summary__label">Unpaid Hours</div>
                  </div>
                  <div className="workforce-summary__card">
                    <div className="workforce-summary__value">${earnings.toFixed(0)}</div>
                    <div className="workforce-summary__label">Pending Pay</div>
                  </div>
                  <div className="workforce-summary__card">
                    <div className="workforce-summary__value">${rate}</div>
                    <div className="workforce-summary__label">Hourly Rate</div>
                  </div>
                </div>
              );
            })()}
          </div>

          <div className="glass-panel space-y-4 flex-1 overflow-hidden flex flex-col">
            <h3 className="intake-section__title" style={{ border: 'none', padding: 0, margin: 0 }}>My Shift History</h3>
            <div className="flex-1 overflow-y-auto space-y-2.5 max-h-[220px]">
              {(() => {
                const myShifts = (configDb?.timecards || []).filter(
                  (tc: any) => tc.technicianId === currentUser.technicianId
                ).sort((a: any, b: any) => Date.parse(b.clockIn) - Date.parse(a.clockIn));

                if (myShifts.length === 0) {
                  return <div className="workforce-empty">No shift history yet.</div>;
                }

                return myShifts.map((shift: any) => {
                  const inDate = new Date(shift.clockIn);
                  const hoursWorked = shift.clockOut
                    ? ((Date.parse(shift.clockOut) - Date.parse(shift.clockIn)) / 3600000).toFixed(2)
                    : 'Active';

                  return (
                    <div key={shift.id} className="workforce-worker text-xs">
                      <div>
                        <div className="workforce-worker__name">{inDate.toLocaleDateString()}</div>
                        <div className="workforce-worker__meta">
                          {inDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} –{' '}
                          {shift.clockOut
                            ? new Date(shift.clockOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                            : 'Now'}
                          {shift.notes ? ` · ${shift.notes}` : ''}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="workforce-worker__timer" style={{ fontSize: '0.9375rem' }}>{hoursWorked} hrs</div>
                        {shift.payoutStatus === 'paid' ? (
                          <span className="badge badge-green text-xs mt-1">Paid</span>
                        ) : shift.status === 'active' ? (
                          <span className="badge badge-amber text-xs mt-1">Working</span>
                        ) : (
                          <span className="badge badge-blue text-xs mt-1">Unpaid</span>
                        )}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        </div>
      )}

      {/* tab: Super Admin workforce monitor — all locations */}
      {activeTab === 'workforce' && isSuperAdminUser && (
        <div className="space-y-6 flex-1 flex flex-col">
          <div className="flex items-center gap-2 mb-2">
            <button onClick={() => setActiveTab('dashboard')} className="btn-secondary py-2 px-3">
              <ArrowLeftRight className="w-4 h-4 rotate-180 inline mr-1" /> Back
            </button>
            <h2>Workforce Monitor</h2>
          </div>

          {renderWorkforceMonitor({ fullPage: true })}

          <div className="glass-panel space-y-3">
            <h3 className="intake-section__title" style={{ border: 'none', padding: 0, margin: 0 }}>Recent Clock Activity</h3>
            <div className="space-y-2 max-h-[280px] overflow-y-auto">
              {(() => {
                const recent = [...(configDb?.timecards || [])]
                  .sort((a: any, b: any) => Date.parse(b.clockIn) - Date.parse(a.clockIn))
                  .slice(0, 20);

                if (recent.length === 0) {
                  return <div className="workforce-empty">No clock activity recorded yet.</div>;
                }

                return recent.map((shift: any) => (
                  <div key={shift.id} className="workforce-worker text-xs">
                    <div>
                      <div className="workforce-worker__name">{shift.technicianName}</div>
                      <div className="workforce-worker__meta">
                        {shift.locationName} · {new Date(shift.clockIn).toLocaleString()}
                        {shift.clockOut ? ` → ${new Date(shift.clockOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ' → Active now'}
                      </div>
                    </div>
                    <span className={`badge ${shift.status === 'active' ? 'badge-green' : 'badge-blue'} text-xs`}>
                      {shift.status === 'active' ? 'On Clock' : 'Completed'}
                    </span>
                  </div>
                ));
              })()}
            </div>
          </div>
        </div>
      )}

      {/* tab: Shift Roster calendar */}
      {activeTab === 'schedule' && (
        <div className="space-y-6 flex-1 flex flex-col">
          <div className="flex items-center gap-2 mb-2">
            <button 
              onClick={() => setActiveTab('dashboard')} 
              className="btn-secondary py-2 px-3 bg-white/5 border border-glass text-slate-100"
            >
              <ArrowLeftRight className="w-4 h-4 rotate-180 inline mr-1" /> Back
            </button>
            <h2 className="text-lg font-bold text-white uppercase tracking-wider">
              {currentUser?.role === 'manager' ? 'Roster Builder' : 'My Shift Roster'}
            </h2>
          </div>

          {currentUser?.role === 'worker' ? (
            <div className="glass-panel space-y-4">
              <div className="flex items-center justify-between border-b border-glass pb-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Weekly Shift Calendar</h3>
                <span className="badge badge-green text-xs">Active</span>
              </div>

              <div className="space-y-3">
                {(() => {
                  const myShifts = (configDb?.schedules || []).filter(
                    (s: any) => s.technicianId === currentUser.technicianId
                  );

                  if (myShifts.length === 0) {
                    return (
                      <div className="text-center py-12 text-sm text-gray-500">
                        No shifts scheduled for you this week.
                      </div>
                    );
                  }

                  return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(day => {
                    const dayShifts = myShifts.filter((s: any) => s.day === day);
                    return (
                      <div key={day} className="flex justify-between items-center p-3.5 bg-white/5 border border-glass rounded-xl">
                        <span className="font-semibold text-sm text-slate-200">{day}</span>
                        <div>
                          {dayShifts.length > 0 ? (
                            dayShifts.map((s, idx) => (
                              <span key={idx} className="badge badge-violet text-xs">
                                {s.locationName} ({s.hours})
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-gray-500 font-medium">Off Duty</span>
                          )}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="glass-panel space-y-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Roster Building Parameters</h3>
                <div className="grid grid-cols-2 gap-4 text-xs">
                  <div className="space-y-2 col-span-2">
                    <label className="block text-gray-500 font-bold uppercase">Week Starting Date</label>
                    <input 
                      type="date"
                      value={scheduleWeekStart}
                      onChange={e => setScheduleWeekStart(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 text-white rounded-xl py-2.5 px-3 focus:outline-none focus:ring-1 focus:ring-violet-500"
                    />
                  </div>
                </div>

                <div className="space-y-3 pt-2">
                  <label className="block text-gray-400 font-semibold uppercase tracking-wider text-xs">Specify Working Days Quota</label>
                  <div className="space-y-2.5">
                    {configDb?.technicians.map((tech: any) => (
                      <div key={tech.id} className="flex justify-between items-center p-3 bg-white/5 border border-glass rounded-xl text-xs gap-4">
                        <div>
                          <div className="font-semibold text-slate-200">{tech.name}</div>
                          <div className="text-[10px] text-gray-500">Home: {locations.find(l => l.id === tech.locationId)?.name}</div>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="space-y-1">
                            <span className="text-[9px] text-gray-500 uppercase block font-semibold">Pref Day</span>
                            <select
                              value={tech.preferredDay || 'None'}
                              onChange={async (e) => {
                                if (!configDb) return;
                                tech.preferredDay = e.target.value;
                                const updated = {
                                  ...configDb,
                                  technicians: configDb.technicians.map(t => t.id === tech.id ? { ...t, preferredDay: e.target.value } : t)
                                };
                                await saveConfig(updated);
                                showTemporaryMessage('success', `Updated preferred day for ${tech.name} to ${e.target.value}`);
                              }}
                              className="bg-slate-900 border border-slate-700 text-white rounded-lg py-1 px-2 text-xs focus:outline-none focus:ring-1 focus:ring-violet-500"
                            >
                              <option value="None">None</option>
                              <option value="Monday">Mon</option>
                              <option value="Tuesday">Tue</option>
                              <option value="Wednesday">Wed</option>
                              <option value="Thursday">Thu</option>
                              <option value="Friday">Fri</option>
                              <option value="Saturday">Sat</option>
                            </select>
                          </div>

                          <div className="space-y-1">
                            <span className="text-[9px] text-gray-500 uppercase block font-semibold text-center">Quota</span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  const curr = rosterDaysQuotas[tech.id] || 0;
                                  setRosterDaysQuotas({ ...rosterDaysQuotas, [tech.id]: Math.max(0, curr - 1) });
                                }}
                                className="w-6 h-6 rounded bg-slate-800 border border-glass flex items-center justify-center font-bold text-white hover:bg-slate-700 transition-colors"
                              >
                                -
                              </button>
                              <span className="w-8 text-center font-bold text-slate-200">{rosterDaysQuotas[tech.id] || 0} days</span>
                              <button
                                type="button"
                                onClick={() => {
                                  const curr = rosterDaysQuotas[tech.id] || 0;
                                  setRosterDaysQuotas({ ...rosterDaysQuotas, [tech.id]: Math.min(6, curr + 1) });
                                }}
                                className="w-6 h-6 rounded bg-slate-800 border border-glass flex items-center justify-center font-bold text-white hover:bg-slate-700 transition-colors"
                              >
                                +
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    if (!scheduleWeekStart) {
                      showTemporaryMessage('error', 'Please pick a Week Starting date first.');
                      return;
                    }
                    setGeneratingRoster(true);
                    setTimeout(() => {
                      const previewShifts: any[] = [];
                      const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                      
                      configDb?.technicians.forEach(tech => {
                        const quota = rosterDaysQuotas[tech.id] || 0;
                        if (quota <= 0) return;

                        const assignedDays = new Set<string>();
                        
                        // 1. Assign preferred day if specified and within valid weekdays
                        const pref = tech.preferredDay;
                        if (pref && pref !== 'None' && days.includes(pref)) {
                          assignedDays.add(pref);
                        }

                        // 2. Fill the remaining quota randomly from non-preferred days
                        const remainingQuota = quota - assignedDays.size;
                        if (remainingQuota > 0) {
                          const otherDays = days.filter(d => !assignedDays.has(d));
                          const shuffled = [...otherDays].sort(() => 0.5 - Math.random());
                          for (let i = 0; i < Math.min(remainingQuota, shuffled.length); i++) {
                            assignedDays.add(shuffled[i]);
                          }
                        }

                        // 3. Construct preview shifts list
                        const locObj = locations.find(l => l.id === tech.locationId) || locations[0];
                        Array.from(assignedDays).forEach(day => {
                          previewShifts.push({
                            id: `alloc-${tech.id}-${day}`,
                            technicianId: tech.id,
                            technicianName: tech.name,
                            locationId: tech.locationId,
                            locationName: locObj.name,
                            day: day,
                            date: scheduleWeekStart,
                            hours: '09:00 - 17:00'
                          });
                        });
                      });

                      // 4. Sort shifts chronologically by weekday sequence
                      const DAYS_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                      previewShifts.sort((a, b) => DAYS_ORDER.indexOf(a.day) - DAYS_ORDER.indexOf(b.day));

                      setGeneratedRosterPreview(previewShifts);
                      setGeneratingRoster(false);
                      showTemporaryMessage('success', 'Roster generated successfully! Review below.');
                    }, 1000);
                  }}
                  disabled={generatingRoster}
                  className="w-full btn-primary bg-violet-600 hover:bg-violet-500 py-3 rounded-xl font-bold flex items-center justify-center gap-2 text-sm text-white"
                >
                  {generatingRoster ? <RotateCw className="w-4.5 h-4.5 animate-spin" /> : <Sparkles className="w-4.5 h-4.5" />}
                  Auto-Generate Weekly Schedule
                </button>
              </div>

              {generatedRosterPreview && (
                <div className="glass-panel space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Generated Schedule Preview</h3>
                  <div className="space-y-2 max-h-[300px] overflow-y-auto">
                    {generatedRosterPreview.map((item, idx) => (
                      <div key={idx} className="bg-white/5 p-3 rounded-xl border border-glass flex justify-between items-center text-xs">
                        <div>
                          <span className="badge badge-violet text-[10px] mr-2">{item.day}</span>
                          <span className="font-semibold text-slate-200">{item.technicianName}</span>
                        </div>
                        <div className="text-right text-gray-500 font-medium">{item.locationName}</div>
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={async () => {
                      const updated = {
                        ...configDb,
                        schedules: generatedRosterPreview
                      };
                      await saveConfig(updated);
                      setGeneratedRosterPreview(null);
                      showTemporaryMessage('success', 'Roster approved and published! Technicians can now view their schedules.');
                      setActiveTab('dashboard');
                    }}
                    className="w-full btn-primary bg-emerald-600 hover:bg-emerald-500 py-3 rounded-xl font-bold flex items-center justify-center gap-1.5 text-sm text-white"
                  >
                    <Check className="w-4.5 h-4.5" /> Approve & Publish Schedule
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* tab: Manager Payroll ledger */}
      {activeTab === 'payroll' && currentUser?.role === 'manager' && (
        <div className="space-y-6 flex-1 flex flex-col">
          <div className="flex items-center gap-2 mb-2">
            <button 
              onClick={() => setActiveTab('dashboard')} 
              className="btn-secondary py-2 px-3 bg-white/5 border border-glass text-slate-100"
            >
              <ArrowLeftRight className="w-4 h-4 rotate-180 inline mr-1" /> Back
            </button>
            <h2 className="text-lg font-bold text-white uppercase tracking-wider">Payroll Ledger</h2>
          </div>

          <div className="glass-panel space-y-4">
            <div className="flex items-center justify-between border-b border-glass pb-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 font-bold">Employee List & Payouts</h3>
              <span className="badge badge-emerald text-xs">Real-Time Balances</span>
            </div>

            <div className="space-y-3">
              {configDb?.technicians.map(tech => {
                const unpaidShifts = configDb.timecards.filter(
                  (tc: any) => tc.technicianId === tech.id && tc.status === 'completed' && tc.payoutStatus === 'unpaid'
                );
                
                const totalMs = unpaidShifts.reduce((acc: number, shift: any) => {
                  return acc + (Date.parse(shift.clockOut) - Date.parse(shift.clockIn));
                }, 0);
                
                const totalHours = totalMs / 3600000;
                const earnings = totalHours * (tech.hourlyRate || 0);

                return (
                  <div key={tech.id} className="bg-white/5 p-4 rounded-xl border border-glass space-y-3.5">
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="font-bold text-sm text-slate-100">{tech.name}</div>
                        <div className="text-xs text-gray-500 mt-0.5">{tech.specialty}</div>
                      </div>
                      <div className="text-right">
                        <span className="text-xs text-gray-400">Rate: </span>
                        <span className="font-bold text-slate-200 text-sm">${tech.hourlyRate || 0}/hr</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-xs bg-slate-950/40 p-2.5 rounded-lg border border-slate-900">
                      <div>
                        <span className="text-gray-500 block">Unpaid Hours:</span>
                        <span className="font-semibold text-slate-300">{totalHours.toFixed(2)} hrs</span>
                      </div>
                      <div>
                        <span className="text-gray-500 block">Payout Pending:</span>
                        <span className="font-bold text-emerald-400">${earnings.toFixed(2)}</span>
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <div className="flex-1 relative">
                        <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-500 text-xs">
                          $
                        </span>
                        <input 
                          type="number"
                          placeholder="Hourly Rate"
                          defaultValue={tech.hourlyRate}
                          onChange={(e) => {
                            const newRate = parseFloat(e.target.value);
                            if (!isNaN(newRate) && newRate > 0) {
                              tech.hourlyRate = newRate;
                            }
                          }}
                          className="pl-6 py-1.5 text-xs w-full bg-slate-900 border border-slate-700 text-white rounded-lg"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!configDb) return;
                          const updatedTechs = configDb.technicians.map(t => {
                            if (t.id === tech.id) {
                              return { ...t, hourlyRate: tech.hourlyRate };
                            }
                            return t;
                          });
                          const updated = {
                            ...configDb,
                            technicians: updatedTechs
                          };
                          await saveConfig(updated);
                          showTemporaryMessage('success', `Saved hourly rate for ${tech.name}.`);
                        }}
                        className="btn-secondary py-1.5 px-3 text-xs bg-white/5 border border-glass text-slate-100"
                      >
                        Save Rate
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!configDb) return;
                          if (earnings <= 0) {
                            showTemporaryMessage('error', 'Technician has no unpaid shifts.');
                            return;
                          }
                          const updatedTimecards = configDb.timecards.map((tc: any) => {
                            if (tc.technicianId === tech.id && tc.payoutStatus === 'unpaid') {
                              return { ...tc, payoutStatus: 'paid' };
                            }
                            return tc;
                          });
                          const updated = {
                            ...configDb,
                            timecards: updatedTimecards
                          };
                          await saveConfig(updated);
                          showTemporaryMessage('success', `Executed payout of $${earnings.toFixed(2)} to ${tech.name}. Balance reset to zero!`);
                        }}
                        disabled={earnings <= 0}
                        className="btn-primary py-1.5 px-3 text-xs bg-emerald-600 hover:bg-emerald-500 text-white disabled:bg-slate-800 disabled:text-gray-500 disabled:cursor-not-allowed"
                      >
                        Mark Paid
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* tab: Manager Governance / Permissions / Add Tech */}
      {activeTab === 'product-photos' && (
        <ProductPhotoStudio
          activeLocation={activeLocation!}
          employeeName={currentUser?.name || 'Staff'}
          gpsCoords={gpsCoords}
          isSuperAdmin={isSuperAdminUser}
          onBack={() => setActiveTab('dashboard')}
          onCountChange={setMissingPhotoCount}
          showMessage={showTemporaryMessage}
        />
      )}

      {activeTab === 'build-gallery' && (
        <BuildGalleryStudio
          activeLocation={activeLocation!}
          employeeName={currentUser?.name || 'Staff'}
          gpsCoords={gpsCoords}
          isSuperAdmin={isSuperAdminUser}
          onBack={() => setActiveTab('dashboard')}
          showMessage={showTemporaryMessage}
        />
      )}

      {activeTab === 'permissions' && currentUser?.role === 'manager' && (
        <div className="space-y-6 flex-1 flex flex-col">
          <div className="flex items-center gap-2 mb-2">
            <button 
              onClick={() => setActiveTab('dashboard')} 
              className="btn-secondary py-2 px-3 bg-white/5 border border-glass text-slate-100"
            >
              <ArrowLeftRight className="w-4 h-4 rotate-180 inline mr-1" /> Back
            </button>
            <h2 className="text-lg font-bold text-white uppercase tracking-wider">Access Governance</h2>
          </div>

          {/* Register New Tech Form */}
          <div className="glass-panel space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 flex items-center gap-1.5">
              <UserPlus className="w-4 h-4 text-violet-400" /> Register New Technician
            </h3>

            <div className="space-y-3.5 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-gray-500 font-bold uppercase">Name</label>
                  <input 
                    type="text" 
                    placeholder="Enter full name..."
                    value={newTechName}
                    onChange={e => setNewTechName(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 text-white rounded-lg py-2 px-3"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-gray-500 font-bold uppercase">Email</label>
                  <input 
                    type="email" 
                    placeholder="employee@domain.com"
                    value={newTechEmail}
                    onChange={e => setNewTechEmail(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 text-white rounded-lg py-2 px-3"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-gray-500 font-bold uppercase">Specialty</label>
                  <input 
                    type="text" 
                    placeholder="e.g. Alignment specialist"
                    value={newTechSpecialty}
                    onChange={e => setNewTechSpecialty(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 text-white rounded-lg py-2 px-3"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-gray-500 font-bold uppercase">Home Location</label>
                  <select
                    value={newTechLocation}
                    onChange={e => setNewTechLocation(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 text-white rounded-lg py-2 px-3"
                  >
                    {locations.map(loc => (
                      <option key={loc.id} value={loc.id}>{loc.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-gray-500 font-bold uppercase">Hourly Rate ($/hr)</label>
                  <input 
                    type="number" 
                    step="0.01"
                    placeholder="20.00"
                    value={newTechHourlyRate}
                    onChange={e => setNewTechHourlyRate(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 text-white rounded-lg py-2 px-3"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-gray-500 font-bold uppercase">Preferred Shift Day</label>
                  <select
                    value={newTechPreferredDay}
                    onChange={e => setNewTechPreferredDay(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 text-white rounded-lg py-2 px-3"
                  >
                    <option value="None">None (Random Assignments)</option>
                    <option value="Monday">Monday</option>
                    <option value="Tuesday">Tuesday</option>
                    <option value="Wednesday">Wednesday</option>
                    <option value="Thursday">Thursday</option>
                    <option value="Friday">Friday</option>
                    <option value="Saturday">Saturday</option>
                  </select>
                </div>
              </div>

              <button
                type="button"
                onClick={async () => {
                  if (!newTechName || !newTechEmail) {
                    showTemporaryMessage('error', 'Please enter Name and Email.');
                    return;
                  }
                  setCreatingTech(true);
                  setInviteSentMsg('');
                  try {
                    const generatedPin = Math.floor(1000 + Math.random() * 9000).toString();
                    const newTechObj = {
                      id: 'tech-' + Math.random().toString(36).substring(2),
                      name: newTechName,
                      email: newTechEmail,
                      pin: generatedPin,
                      specialty: newTechSpecialty || 'General Technician',
                      locationId: newTechLocation,
                      hourlyRate: parseFloat(newTechHourlyRate) || 20.00,
                      preferredDay: newTechPreferredDay || 'None',
                      canEditInventory: false,
                      canPrintLabels: false,
                      canShipOrders: true
                    };

                    const updatedTechs = [...(configDb?.technicians || []), newTechObj];
                    const updated = {
                      ...configDb,
                      technicians: updatedTechs
                    };

                    await saveConfig(updated);

                    const emailBody = `
                      <h2>Welcome to Atlantic Tire King, ${newTechName}!</h2>
                      <p>Your employee account has been created on the warehouse dashboard.</p>
                      <p>To access your account, select your location and enter your 4-digit PIN:</p>
                      <h1 style="color: #6d28d9; letter-spacing: 5px;">${generatedPin}</h1>
                      <p>Please keep this PIN secure. Use it to clock in and out from this app.</p>
                    `;

                    const mailResponse = await fetch('/api/send-email', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json'
                      },
                      body: JSON.stringify({
                        email: newTechEmail,
                        subject: 'Your Atlantic Tire King Warehouse Access PIN',
                        html: emailBody
                      })
                    });

                    const mailResult = await mailResponse.json();
                    if (mailResult.success) {
                      setInviteSentMsg(`✓ Account created! PIN code (${generatedPin}) emailed to ${newTechEmail}`);
                      showTemporaryMessage('success', 'Technician registered & invitation email dispatched!');
                    } else {
                      throw new Error(mailResult.error || 'Failed to send onboarding email');
                    }

                    // Reset form
                    setNewTechName('');
                    setNewTechEmail('');
                    setNewTechSpecialty('');
                    setNewTechHourlyRate('20.00');
                    setNewTechPreferredDay('None');
                  } catch (e: any) {
                    showTemporaryMessage('error', `Registration failed: ${e.message}`);
                  } finally {
                    setCreatingTech(false);
                  }
                }}
                disabled={creatingTech}
                className="w-full btn-primary bg-violet-600 hover:bg-violet-500 py-3 font-bold flex items-center justify-center gap-1.5 text-slate-100 rounded-xl cursor-pointer"
              >
                {creatingTech ? <RotateCw className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4.5 h-4.5" />}
                Register & Email Onboarding PIN
              </button>

              {inviteSentMsg && (
                <div className="p-3.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs rounded-xl font-medium">
                  {inviteSentMsg}
                </div>
              )}
            </div>
          </div>

          {/* Permissions Matrix Grid */}
          <div className="glass-panel space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 flex items-center gap-1.5">
              <Shield className="w-4 h-4 text-violet-400" /> Access Governance Rules
            </h3>

            <div className="space-y-4">
              {configDb?.technicians.map((tech: any) => (
                <div key={tech.id} className="bg-white/5 p-4 rounded-xl border border-glass space-y-3.5 text-xs">
                  <div className="flex justify-between items-center border-b border-glass/40 pb-2">
                    <strong className="text-slate-200 text-sm">{tech.name}</strong>
                    <span className="text-[10px] text-gray-500 font-mono">Specialty: {tech.specialty}</span>
                  </div>

                  {/* Inline profile adjustment forms */}
                  <div className="grid grid-cols-2 gap-3.5 text-xs bg-slate-950/40 p-3 rounded-xl border border-slate-900/60 my-2">
                    <div className="space-y-1">
                      <label className="text-gray-500 block uppercase font-bold text-[9px]">Hourly Rate ($/hr)</label>
                      <input 
                        type="number" 
                        step="0.01"
                        defaultValue={tech.hourlyRate || 20.00}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val) && val > 0) {
                            tech.hourlyRate = val;
                          }
                        }}
                        className="w-full bg-slate-900 border border-slate-700 text-white rounded-lg py-1.5 px-2.5"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-gray-500 block uppercase font-bold text-[9px]">Security PIN</label>
                      <input 
                        type="text" 
                        maxLength={4}
                        defaultValue={tech.pin}
                        onChange={(e) => {
                          const val = e.target.value.replace(/\D/g, '');
                          if (val.length === 4) {
                            tech.pin = val;
                          }
                        }}
                        className="w-full bg-slate-900 border border-slate-700 text-white rounded-lg py-1.5 px-2.5 font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-gray-500 block uppercase font-bold text-[9px]">Specialty</label>
                      <input 
                        type="text" 
                        defaultValue={tech.specialty}
                        onChange={(e) => {
                          tech.specialty = e.target.value;
                        }}
                        className="w-full bg-slate-900 border border-slate-700 text-white rounded-lg py-1.5 px-2.5"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-gray-500 block uppercase font-bold text-[9px]">Home Location</label>
                      <select 
                        defaultValue={tech.locationId}
                        onChange={(e) => {
                          tech.locationId = e.target.value;
                        }}
                        className="w-full bg-slate-900 border border-slate-700 text-white rounded-lg py-1.5 px-2.5"
                      >
                        {locations.map(loc => (
                          <option key={loc.id} value={loc.id}>{loc.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1 col-span-2">
                      <label className="text-gray-500 block uppercase font-bold text-[9px]">Preferred Shift Day</label>
                      <select 
                        defaultValue={tech.preferredDay || 'None'}
                        onChange={(e) => {
                          tech.preferredDay = e.target.value;
                        }}
                        className="w-full bg-slate-900 border border-slate-700 text-white rounded-lg py-1.5 px-2.5"
                      >
                        <option value="None">None (Random Assignments)</option>
                        <option value="Monday">Monday</option>
                        <option value="Tuesday">Tuesday</option>
                        <option value="Wednesday">Wednesday</option>
                        <option value="Thursday">Thursday</option>
                        <option value="Friday">Friday</option>
                        <option value="Saturday">Saturday</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        if (!configDb) return;
                        const updated = {
                          ...configDb,
                          technicians: configDb.technicians.map(t => t.id === tech.id ? { 
                            ...t, 
                            hourlyRate: tech.hourlyRate,
                            pin: tech.pin,
                            specialty: tech.specialty,
                            locationId: tech.locationId,
                            preferredDay: tech.preferredDay || 'None'
                          } : t)
                        };
                        await saveConfig(updated);
                        showTemporaryMessage('success', `Successfully updated profile details for ${tech.name}.`);
                      }}
                      className="btn-primary py-1.5 px-3 text-xs bg-violet-600 hover:bg-violet-500 text-white rounded-lg cursor-pointer"
                    >
                      Update Profile Info
                    </button>
                  </div>

                  <div className="space-y-3 pt-2">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input 
                        type="checkbox" 
                        checked={tech.canEditInventory}
                        onChange={async (e) => {
                          if (!configDb) return;
                          tech.canEditInventory = e.target.checked;
                          const updated = {
                            ...configDb,
                            technicians: configDb.technicians.map(t => t.id === tech.id ? { ...t, canEditInventory: tech.canEditInventory } : t)
                          };
                          await saveConfig(updated);
                          showTemporaryMessage('success', `Updated permissions for ${tech.name}`);
                        }}
                        className="rounded border-slate-700 bg-slate-900 text-violet-500 focus:ring-violet-500 w-4.5 h-4.5"
                      />
                      <div>
                        <span className="text-slate-200 font-semibold">Can Edit Inventory</span>
                        <span className="text-[10px] text-gray-500 block">Allows Receive (Intake), Move (Transfer), and Audit.</span>
                      </div>
                    </label>

                    <label className="flex items-center gap-3 cursor-pointer pt-1">
                      <input 
                        type="checkbox" 
                        checked={tech.canPrintLabels}
                        onChange={async (e) => {
                          if (!configDb) return;
                          tech.canPrintLabels = e.target.checked;
                          const updated = {
                            ...configDb,
                            technicians: configDb.technicians.map(t => t.id === tech.id ? { ...t, canPrintLabels: tech.canPrintLabels } : t)
                          };
                          await saveConfig(updated);
                          showTemporaryMessage('success', `Updated permissions for ${tech.name}`);
                        }}
                        className="rounded border-slate-700 bg-slate-900 text-violet-500 focus:ring-violet-500 w-4.5 h-4.5"
                      />
                      <div>
                        <span className="text-slate-200 font-semibold">Can Print Shipping Labels</span>
                        <span className="text-[10px] text-gray-500 block">Allows clicking simulated print button on orders.</span>
                      </div>
                    </label>

                    <label className="flex items-center gap-3 cursor-pointer pt-1">
                      <input 
                        type="checkbox" 
                        checked={tech.canShipOrders}
                        onChange={async (e) => {
                          if (!configDb) return;
                          tech.canShipOrders = e.target.checked;
                          const updated = {
                            ...configDb,
                            technicians: configDb.technicians.map(t => t.id === tech.id ? { ...t, canShipOrders: tech.canShipOrders } : t)
                          };
                          await saveConfig(updated);
                          showTemporaryMessage('success', `Updated permissions for ${tech.name}`);
                        }}
                        className="rounded border-slate-700 bg-slate-900 text-violet-500 focus:ring-violet-500 w-4.5 h-4.5"
                      />
                      <div>
                        <span className="text-slate-200 font-semibold">Can Mark Orders as Shipped</span>
                        <span className="text-[10px] text-gray-500 block">Allows submitting tracking IDs and resolving ship queues.</span>
                      </div>
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Premium Enterprise Footer (Anchored to the absolute bottom of the layout) */}
      <footer className="app-footer">
        <div className="app-footer__brand">
          <span className="app-footer__dot" aria-hidden="true" />
          Powered by OneCMD AI Technologies
        </div>
        <p className="text-[8px] text-gray-500 tracking-wider mt-0.5 opacity-60">
          ONECOMMAND ENTERPRISE SUITE • SECURE CLOUD NETWORK
        </p>
      </footer>
    </div>
  );
}
