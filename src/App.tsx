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
  X
} from 'lucide-react';
import { supabase } from './supabaseClient';
import { parseTireSticker, parseTireSidewall, estimateStackCount, inferWinterApprovedFromCatalog } from './openaiClient';
import type { TireStickerData } from './openaiClient';
import { offlineStorage, updateStockLevel } from './offlineStorage';
import type { PendingTransaction } from './offlineStorage';
import { ScanViewfinder } from './components/ScanViewfinder';
import { WinterApprovedToggle } from './components/WinterApprovedToggle';

type ActiveTab = 'dashboard' | 'receive' | 'transfer' | 'verify' | 'estimate' | 'audit' | 'orders' | 'logs';

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

export const STAFF_PINS: Record<string, { role: 'worker' | 'manager'; name: string; location: string }> = {
  // Moncton
  '1111': { role: 'worker', name: 'Moncton Worker 1', location: 'moncton' },
  '1112': { role: 'worker', name: 'Moncton Worker 2', location: 'moncton' },
  '9999': { role: 'manager', name: 'Moncton Manager', location: 'moncton' },
  // Oromocto
  '2221': { role: 'worker', name: 'Oromocto Worker 1', location: 'oromocto' },
  '2222': { role: 'worker', name: 'Oromocto Worker 2', location: 'oromocto' },
  '8888': { role: 'manager', name: 'Oromocto Manager', location: 'oromocto' },
  // Saint John
  '3331': { role: 'worker', name: 'Saint John Worker 1', location: 'saint-john' },
  '3332': { role: 'worker', name: 'Saint John Worker 2', location: 'saint-john' },
  '7777': { role: 'manager', name: 'Saint John Manager', location: 'saint-john' },
  // Fredericton
  '4441': { role: 'worker', name: 'Fredericton Worker 1', location: 'fredericton' },
  '4442': { role: 'worker', name: 'Fredericton Worker 2', location: 'fredericton' },
  '6666': { role: 'manager', name: 'Fredericton Manager', location: 'fredericton' }
};

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
  const [currentUser, setCurrentUser] = useState<{ role: 'worker' | 'manager'; name: string; location: string } | null>(() => {
    const saved = localStorage.getItem('onecmd_current_user');
    return saved ? JSON.parse(saved) : null;
  });
  const [authError, setAuthError] = useState<string>('');

  // General App State
  const [activeTab, setActiveTab] = useState<ActiveTab>('dashboard');
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [pendingSyncCount, setPendingSyncCount] = useState<number>(0);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [globalMessage, setGlobalMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Locations Catalog Cache
  const [locations] = useState<Array<{ id: string; name: string }>>([
    { id: 'moncton', name: 'Moncton Warehouse' },
    { id: 'oromocto', name: 'Oromocto Warehouse' },
    { id: 'halifax', name: 'Halifax Hub' },
    { id: 'fredericton', name: 'Fredericton Outlet' },
    { id: 'saint-john', name: 'Saint John Hub' },
    { id: 'otown-auto', name: 'O-Town Auto' }
  ]);

  // Core Feature State: Orders Shipping & Labels
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<CustomerOrder | null>(null);
  const [trackingInput, setTrackingInput] = useState<string>('');
  const [dispatching, setDispatching] = useState<boolean>(false);

  // Core Feature State: Receive
  const [receivePhoto, setReceivePhoto] = useState<string | null>(null);
  const [extractedSpecs, setExtractedSpecs] = useState<TireStickerData | null>(null);
  const [extracting, setExtracting] = useState<boolean>(false);
  const [quantityInput, setQuantityInput] = useState<string>('');
  const [savingReceive, setSavingReceive] = useState<boolean>(false);
  const [skuExists, setSkuExists] = useState<boolean | null>(null);
  const [winterApproved, setWinterApproved] = useState<boolean>(false);
  const [winterApprovedAiDetected, setWinterApprovedAiDetected] = useState<boolean>(false);
  const [receiveScanError, setReceiveScanError] = useState<string>('');
  const [undoingIntake, setUndoingIntake] = useState<boolean>(false);
  const [scanMode, setScanMode] = useState<'sticker' | 'sidewall'>('sticker');

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

  // File Inputs references for opening camera
  const transferFileRef = useRef<HTMLInputElement>(null);
  const verifyFileRef = useRef<HTMLInputElement>(null);
  const estimatorFileRef = useRef<HTMLInputElement>(null);
  const auditFileRef = useRef<HTMLInputElement>(null);

  // Monitor network status & offline queue
  useEffect(() => {
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

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

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
      if (activeTab === 'logs') {
        fetchRecentTransactions();
      }
    }
  }, [activeLocation, activeTab]);

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

        // 2. Subtract inventory from catalog for each item shipped
        for (const item of order.items) {
          await updateStockLevel(item.sku, 'tire', activeLocation!, -item.quantity);
        }

        // 3. Log transaction
        for (const item of order.items) {
          await supabase.from('inventory_transactions').insert({
            sku: item.sku,
            product_type: 'tire',
            transaction_type: 'transfer',
            quantity: item.quantity,
            from_location: activeLocation,
            status: 'completed',
            employee_id: 'auto_shipping',
            notes: `Shipped order ${order.order_number} to ${order.customer_name}. Tracking: ${trackingInput}`
          });
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

  // Location authentication handling
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeLocation) {
      setAuthError('Please select a location.');
      return;
    }

    const employee = STAFF_PINS[pinInput];
    if (employee && employee.location === activeLocation) {
      const selected = locations.find(l => l.id === activeLocation);
      const name = selected ? selected.name : activeLocation;
      setLocationName(name);
      setCurrentUser(employee);
      
      localStorage.setItem('onecmd_active_location', activeLocation);
      localStorage.setItem('onecmd_active_location_name', name);
      localStorage.setItem('onecmd_current_user', JSON.stringify(employee));
      
      setPinInput('');
      setAuthError('');
      showTemporaryMessage('success', `Welcome back, ${employee.name}! Logged in at ${name}.`);
    } else {
      setAuthError('Invalid 4-digit Employee PIN for this location. Please try again.');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('onecmd_active_location');
    localStorage.removeItem('onecmd_active_location_name');
    localStorage.removeItem('onecmd_current_user');
    setActiveLocation(null);
    setLocationName('');
    setCurrentUser(null);
    setActiveTab('dashboard');
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
    setSkuExists(null);
    setReceiveScanError('');
    setWinterApproved(false);
    setWinterApprovedAiDetected(false);
    try {
      const parsed = scanMode === 'sidewall'
        ? await parseTireSidewall(base64)
        : await parseTireSticker(base64);
      
      if (!parsed.product_type) {
        parsed.product_type = 'tire';
      }
      setExtractedSpecs(parsed);

      const inferredWinter = inferWinterApprovedFromCatalog(parsed.brand, parsed.model, parsed);
      setWinterApproved(inferredWinter);
      setWinterApprovedAiDetected(Boolean(parsed.has_3pmsf || parsed.winter_approved));

      if (!parsed.brand || !parsed.size) {
        setReceiveScanError(
          scanMode === 'sidewall'
            ? 'Could not read sidewall brand or size. Retake in better light with tire markings clearly visible and in frame.'
            : 'Could not read brand or size. Retake in better light with the full sticker in frame.'
        );
        return;
      }
      
      // Query if SKU exists in master catalog
      if (isOnline && parsed.size) {
        const generatedSku = formatSku(parsed.brand, parsed.size, parsed.model || '');
        const { data } = await supabase
          .from('tires_catalog')
          .select('sku')
          .eq('sku', generatedSku)
          .maybeSingle();
        setSkuExists(!!data);
      }
    } catch (err: any) {
      setReceiveScanError(err.message || 'AI label extraction failed. Hold steady and retake the photo.');
      showTemporaryMessage('error', `AI label extraction failed: ${err.message}`);
    } finally {
      setExtracting(false);
    }
  };

  // Save parsed intake inventory
  const handleSaveReceive = async () => {
    if (!extractedSpecs || !quantityInput) return;
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
        const table = isWheel ? 'wheels_catalog' : 'tires_catalog';

        // Check if SKU exists
        const { data: existingItem } = await supabase
          .from(table)
          .select('sku')
          .eq('sku', generatedSku)
          .maybeSingle();
        const itemExists = !!existingItem;

        if (!itemExists) {
          let catalogName = `${extractedSpecs.brand} ${extractedSpecs.model || ''}`;
          if (isWheel) {
            if (extractedSpecs.finish) catalogName += ` ${extractedSpecs.finish}`;
            catalogName += ` (${extractedSpecs.size}`;
            if (extractedSpecs.bolt_pattern) catalogName += ` PCD:${extractedSpecs.bolt_pattern}`;
            if (extractedSpecs.offset) catalogName += ` ET:${extractedSpecs.offset}`;
            if (extractedSpecs.center_bore) catalogName += ` CB:${extractedSpecs.center_bore}`;
            catalogName += ')';
          } else {
            if (extractedSpecs.ply_rating && extractedSpecs.ply_rating !== 'N/A') {
              catalogName += ` (${extractedSpecs.ply_rating})`;
            }
            if (winterApproved) {
              catalogName += ' 3PMSF';
            }
          }

          const insertPayload: any = {
            sku: generatedSku,
            brand: extractedSpecs.brand,
            size: extractedSpecs.size,
            name: catalogName,
            price: isWheel ? 180 : 120,
            stock: 0,
            image: '',
            location_counts: {}
          };
          if (!isWheel) {
            insertPayload.type = extractedSpecs.season || 'All-Season';
            insertPayload.winter_approved = winterApproved;
          }

          const { error: upsertErr } = await supabase.from(table).upsert(insertPayload);
          if (upsertErr) throw upsertErr;
        } else if (!isWheel && winterApproved) {
          const { error: winterErr } = await supabase
            .from('tires_catalog')
            .update({ winter_approved: true })
            .eq('sku', generatedSku);
          if (winterErr) throw winterErr;
        }

        const { error: insertErr } = await supabase.from('inventory_transactions').insert(txData);
        if (insertErr) throw insertErr;

        await updateStockLevel(generatedSku, isWheel ? 'wheel' : 'tire', activeLocation!, qty);
      } else {
        // Cache offline
        offlineStorage.enqueue(txData);
        setPendingSyncCount(offlineStorage.getQueue().length);
      }

      showTemporaryMessage('success', `Intake recorded: ${qty}x ${extractedSpecs.brand} ${extractedSpecs.model} added to ${locationName}!`);
      // Reset state
      setReceivePhoto(null);
      setExtractedSpecs(null);
      setQuantityInput('');
      setWinterApproved(false);
      setWinterApprovedAiDetected(false);
      setReceiveScanError('');
      setActiveTab('dashboard');
    } catch (e: any) {
      showTemporaryMessage('error', `Failed to save received stock: ${e.message}`);
    } finally {
      setSavingReceive(false);
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
    
    // Check PIN matches location manager pin
    const managerPins: Record<string, string> = {
      'moncton': '9999',
      'oromocto': '8888',
      'saint-john': '7777',
      'fredericton': '6666'
    };

    if (managerPinInput !== managerPins[activeLocation]) {
      setManagerPinError('Incorrect 4-digit Manager PIN. Override denied.');
      return;
    }

    const newQty = parseInt(newQtyInput);
    if (isNaN(newQty) || newQty < 0) {
      setManagerPinError('Please enter a valid quantity.');
      return;
    }

    try {
      if (isOnline) {
        // 1. Calculate difference and update stock counts
        const diff = newQty - editingTransaction.quantity;
        const targetLoc = editingTransaction.to_location || editingTransaction.from_location || activeLocation;
        await updateStockLevel(editingTransaction.sku, editingTransaction.product_type, targetLoc, diff);

        // 2. Update transaction quantity and status in Supabase
        const { error } = await supabase
          .from('inventory_transactions')
          .update({
            quantity: newQty,
            status: 'completed', // reset status to completed if it was flagged
            notes: `Corrected by ${currentUser?.name || 'Manager'} on override. Original: ${editingTransaction.quantity}`
          })
          .eq('id', editingTransaction.id);

        if (error) throw error;
      } else {
        // Edit offline queue
        const queue = offlineStorage.getQueue();
        const found = queue.find(item => item.id === editingTransaction.id);
        if (found) {
          found.quantity = newQty;
          found.notes = `Corrected locally. Original: ${editingTransaction.quantity}`;
          localStorage.setItem('onecmd_offline_transactions', JSON.stringify(queue));
        }
      }

      showTemporaryMessage('success', 'Transaction successfully updated and inventory counts recalculated.');
      setManagerPinModalOpen(false);
      setEditingTransaction(null);
      fetchRecentTransactions();
    } catch (e: any) {
      setManagerPinError(`Failed to update transaction: ${e.message}`);
    }
  };

  const handleSaveTransactionDelete = async () => {
    if (!editingTransaction || !activeLocation) return;
    
    // Check PIN matches location manager pin
    const managerPins: Record<string, string> = {
      'moncton': '9999',
      'oromocto': '8888',
      'saint-john': '7777',
      'fredericton': '6666'
    };

    if (managerPinInput !== managerPins[activeLocation]) {
      setManagerPinError('Incorrect 4-digit Manager PIN. Override denied.');
      return;
    }

    try {
      if (isOnline) {
        // 1. Revert stock counts completely
        const targetLoc = editingTransaction.to_location || editingTransaction.from_location || activeLocation;
        await updateStockLevel(editingTransaction.sku, editingTransaction.product_type, targetLoc, -editingTransaction.quantity);

        // 2. Delete transaction from Supabase
        const { error } = await supabase
          .from('inventory_transactions')
          .delete()
          .eq('id', editingTransaction.id);

        if (error) throw error;
      } else {
        // Delete from offline queue
        offlineStorage.dequeue(editingTransaction.id);
      }

      showTemporaryMessage('success', 'Transaction deleted and inventory counts reverted.');
      setManagerPinModalOpen(false);
      setEditingTransaction(null);
      fetchRecentTransactions();
    } catch (e: any) {
      setManagerPinError(`Failed to delete transaction: ${e.message}`);
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

      const { data: tire, error: tireErr } = await supabase
        .from('tires_catalog')
        .select('sku, stock, location_counts')
        .eq('sku', tx.sku)
        .maybeSingle();

      if (tireErr) throw tireErr;

      if (tire) {
        const counts = { ...(tire.location_counts || {}) };
        counts[activeLocation] = 0;
        const newTotal = Object.values(counts).reduce<number>(
          (sum, n) => sum + (parseInt(String(n), 10) || 0),
          0
        );

        const { error: updateErr } = await supabase
          .from('tires_catalog')
          .update({ location_counts: counts, stock: newTotal })
          .eq('sku', tx.sku);
        if (updateErr) throw updateErr;
      }

      await supabase.from('inventory_transactions').delete().eq('id', tx.id);

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
        // Insert transaction
        await supabase.from('inventory_transactions').insert(txData);
        // Subtract stock from Moncton source immediately (items become In Transit)
        await updateStockLevel(generatedSku, 'tire', activeLocation!, -qty);
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
        // Update transaction status
        await supabase
          .from('inventory_transactions')
          .update({
            status: 'completed',
            received_quantity: qty,
            verified_at: new Date().toISOString(),
            verified_by: activeLocation!
          })
          .eq('id', selectedTransfer.id);

        // Add verified stock to target destination
        await updateStockLevel(selectedTransfer.sku, selectedTransfer.product_type, activeLocation!, qty);

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
      <div className="flex-1 flex flex-col justify-center px-6 py-12">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center p-3 bg-violet-600/10 rounded-2xl border border-violet-500/20 mb-4">
            <Package className="w-10 h-10 text-violet-500" />
          </div>
          <h1>OneCMD Warehouse</h1>
          <p className="text-gray-400 mt-2">AI-Powered Warehouse Management Terminal</p>
        </div>

        <form onSubmit={handleLogin} className="glass-panel space-y-6">
          <div className="space-y-2">
            <label className="block text-sm font-semibold uppercase tracking-wider text-gray-400">Warehouse Location</label>
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
            <label className="block text-sm font-semibold uppercase tracking-wider text-gray-400">Location PIN / Password</label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 pl-4 flex items-center text-gray-500">
                <Lock className="w-5 h-5" />
              </span>
              <input 
                type="password" 
                placeholder="Enter PIN (e.g. atk_moncton_123)" 
                value={pinInput}
                onChange={e => setPinInput(e.target.value)}
                className="pl-12 w-full"
              />
            </div>
          </div>

          {authError && (
            <div className="flex items-center gap-2 text-rose-500 bg-rose-500/10 p-3 rounded-lg border border-rose-500/20 text-sm">
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              <span>{authError}</span>
            </div>
          )}

          <button type="submit" className="w-full btn-primary">
            Authenticate Location
          </button>
        </form>
        
        <div className="text-center text-xs text-gray-500 mt-8">
          OneCMD AI Warehouse System v1.0.0
        </div>
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
            {/* Stack of actions in a nice line with updated spacing */}
            <div className="space-y-4">
              <button 
                onClick={() => setActiveTab('receive')}
                className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-lime-500"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-lime-500/10 flex items-center justify-center border border-lime-500/20 text-lime-600">
                    <Plus className="w-6 h-6" />
                  </div>
                  <div className="text-left">
                    <span className="action-card__title">Receive Inventory</span>
                    <span className="action-card__sub">Scan label sticker to increase stock</span>
                  </div>
                </div>
                <span className="badge badge-lime">Intake</span>
              </button>

              <button 
                onClick={() => setActiveTab('transfer')}
                className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-blue-500"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center border border-blue-500/20 text-blue-600">
                    <ArrowLeftRight className="w-5 h-5" />
                  </div>
                  <div className="text-left">
                    <span className="action-card__title">Inter-Store Move</span>
                    <span className="action-card__sub">Transfer items to Oromocto, Saint John, etc.</span>
                  </div>
                </div>
                <span className="badge badge-blue">Transfer</span>
              </button>

              <button 
                onClick={() => setActiveTab('orders')}
                className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-emerald-500"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20 text-emerald-600">
                    <Send className="w-5 h-5" />
                  </div>
                  <div className="text-left">
                    <span className="action-card__title">Orders to Dispatch</span>
                    <span className="action-card__sub">Pack and print labels for customer shipments</span>
                  </div>
                </div>
                {orders.length > 0 ? (
                  <span className="badge badge-rose">{orders.length} Pending</span>
                ) : (
                  <span className="badge badge-green">Ready</span>
                )}
              </button>

              <button 
                onClick={() => setActiveTab('estimate')}
                className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-violet-500"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-violet-500/10 flex items-center justify-center border border-violet-500/20 text-violet-600">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <div className="text-left">
                    <span className="action-card__title">AI Stack Estimator</span>
                    <span className="action-card__sub">Estimate pile counts via vision model</span>
                  </div>
                </div>
                <span className="badge badge-violet">AI Count</span>
              </button>

              <button 
                onClick={() => setActiveTab('audit')}
                className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-amber-500"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center border border-amber-500/20 text-amber-600">
                    <BarChart3 className="w-5 h-5" />
                  </div>
                  <div className="text-left">
                    <span className="action-card__title">Weekly AI Audit</span>
                    <span className="action-card__sub">Compare system records to physical rows</span>
                  </div>
                </div>
                <span className="badge badge-amber">Audit</span>
              </button>

              <button 
                onClick={() => setActiveTab('logs')}
                className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 border-l-4 border-l-rose-500"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-rose-500/10 flex items-center justify-center border border-rose-500/20 text-rose-600">
                    <Lock className="w-5 h-5" />
                  </div>
                  <div className="text-left">
                    <span className="action-card__title">Transaction Logs & Corrections</span>
                    <span className="action-card__sub">View past logs and request stock corrections</span>
                  </div>
                </div>
                <span className="badge badge-rose">Logs</span>
              </button>
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
              <button onClick={() => { setActiveTab('dashboard'); setReceivePhoto(null); setExtractedSpecs(null); setQuantityInput(''); setWinterApproved(false); setReceiveScanError(''); }} className="btn-secondary py-2 px-3">
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
                      ? 'bg-primary text-black shadow-lg shadow-primary/20'
                      : 'bg-glass border border-glass text-gray-400 hover:text-white'
                  }`}
                >
                  📄 Paper Sticker
                </button>
                <button
                  onClick={() => setScanMode('sidewall')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    scanMode === 'sidewall'
                      ? 'bg-primary text-black shadow-lg shadow-primary/20'
                      : 'bg-glass border border-glass text-gray-400 hover:text-white'
                  }`}
                >
                  ⭕ Sidewall Rubber
                </button>
              </div>
            </div>

            {!receivePhoto ? (
              <ScanViewfinder
                label={scanMode === 'sidewall' ? "Take Photo of Tire Sidewall" : "Take Photo of Tire Label"}
                hint={scanMode === 'sidewall' ? "Point camera straight at the embossed rubber text — include DOT code and sizing specs" : "Point camera straight at the sticker — include brand, size, and snowflake symbol if present"}
                accent="lime"
                onCapture={processReceiveSticker}
              />
            ) : (
              <div className="space-y-6 flex-1 flex flex-col">
                <div className="relative rounded-2xl overflow-hidden border border-glass max-h-[200px]">
                  <img src={receivePhoto} alt="Tire Label Preview" className="w-full h-full object-cover" />
                  <button 
                    onClick={() => { setReceivePhoto(null); setExtractedSpecs(null); setReceiveScanError(''); setWinterApproved(false); }} 
                    className="absolute top-2 right-2 btn-secondary py-2 px-3 text-xs"
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
                    <div className="glass-panel space-y-4 glass-panel--success receive-specs-card">
                    <div className="flex items-center justify-between border-b border-glass pb-2">
                      <h3 className="font-bold text-emerald-400">Extracted AI Specs</h3>
                      {skuExists !== null && (
                        <span className={`badge ${skuExists ? 'badge-green' : 'badge-blue'}`}>
                          {skuExists ? 'Existing SKU' : 'New Catalog Product'}
                        </span>
                      )}
                                   <div className="spec-grid gap-y-3 gap-x-2">
                      <div className="col-span-2">
                        <span className="spec-grid__label">Product Type</span>
                        <select
                          value={extractedSpecs.product_type || 'tire'}
                          onChange={(e) => {
                            const val = e.target.value as 'tire' | 'wheel';
                            setExtractedSpecs({ ...extractedSpecs, product_type: val });
                          }}
                          className="bg-glass-dark border border-glass rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-primary w-full mt-1"
                        >
                          <option value="tire">🚗 Tire</option>
                          <option value="wheel">⭕ Wheel</option>
                        </select>
                      </div>

                      {extractedSpecs.product_type === 'wheel' ? (
                        <>
                          <div>
                            <span className="spec-grid__label">Brand</span>
                            <input
                              type="text"
                              value={extractedSpecs.brand || ''}
                              onChange={(e) => setExtractedSpecs({ ...extractedSpecs, brand: e.target.value })}
                              className="bg-glass-dark border border-glass rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-primary w-full mt-1"
                            />
                          </div>
                          <div>
                            <span className="spec-grid__label">Model</span>
                            <input
                              type="text"
                              value={extractedSpecs.model || ''}
                              onChange={(e) => setExtractedSpecs({ ...extractedSpecs, model: e.target.value })}
                              className="bg-glass-dark border border-glass rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-primary w-full mt-1"
                            />
                          </div>
                          <div>
                            <span className="spec-grid__label">Size</span>
                            <input
                              type="text"
                              value={extractedSpecs.size || ''}
                              onChange={(e) => setExtractedSpecs({ ...extractedSpecs, size: e.target.value })}
                              className="bg-glass-dark border border-glass rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-primary w-full mt-1"
                            />
                          </div>
                          <div>
                            <span className="spec-grid__label">Bolt Pattern (PCD)</span>
                            <input
                              type="text"
                              value={extractedSpecs.bolt_pattern || ''}
                              onChange={(e) => setExtractedSpecs({ ...extractedSpecs, bolt_pattern: e.target.value })}
                              className="bg-glass-dark border border-glass rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-primary w-full mt-1"
                            />
                          </div>
                          <div>
                            <span className="spec-grid__label">Offset (ET)</span>
                            <input
                              type="text"
                              value={extractedSpecs.offset || ''}
                              onChange={(e) => setExtractedSpecs({ ...extractedSpecs, offset: e.target.value })}
                              className="bg-glass-dark border border-glass rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-primary w-full mt-1"
                            />
                          </div>
                          <div>
                            <span className="spec-grid__label">Center Bore (CB)</span>
                            <input
                              type="text"
                              value={extractedSpecs.center_bore || ''}
                              onChange={(e) => setExtractedSpecs({ ...extractedSpecs, center_bore: e.target.value })}
                              className="bg-glass-dark border border-glass rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-primary w-full mt-1"
                            />
                          </div>
                          <div>
                            <span className="spec-grid__label">Finish / Color</span>
                            <input
                              type="text"
                              value={extractedSpecs.finish || ''}
                              onChange={(e) => setExtractedSpecs({ ...extractedSpecs, finish: e.target.value })}
                              className="bg-glass-dark border border-glass rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-primary w-full mt-1"
                            />
                          </div>
                          <div>
                            <span className="spec-grid__label">Part Number</span>
                            <input
                              type="text"
                              value={extractedSpecs.part_number || ''}
                              onChange={(e) => setExtractedSpecs({ ...extractedSpecs, part_number: e.target.value })}
                              className="bg-glass-dark border border-glass rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-primary w-full mt-1"
                            />
                          </div>
                        </>
                      ) : (
                        <>
                          <div>
                            <span className="spec-grid__label">Brand</span>
                            <input
                              type="text"
                              value={extractedSpecs.brand || ''}
                              onChange={(e) => setExtractedSpecs({ ...extractedSpecs, brand: e.target.value })}
                              className="bg-glass-dark border border-glass rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-primary w-full mt-1"
                            />
                          </div>
                          <div>
                            <span className="spec-grid__label">Model</span>
                            <input
                              type="text"
                              value={extractedSpecs.model || ''}
                              onChange={(e) => setExtractedSpecs({ ...extractedSpecs, model: e.target.value })}
                              className="bg-glass-dark border border-glass rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-primary w-full mt-1"
                            />
                          </div>
                          <div>
                            <span className="spec-grid__label">Size</span>
                            <input
                              type="text"
                              value={extractedSpecs.size || ''}
                              onChange={(e) => setExtractedSpecs({ ...extractedSpecs, size: e.target.value })}
                              className="bg-glass-dark border border-glass rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-primary w-full mt-1"
                            />
                          </div>
                          <div>
                            <span className="spec-grid__label">Load/Speed</span>
                            <div className="flex gap-1 mt-1">
                              <input
                                type="text"
                                placeholder="LI"
                                value={extractedSpecs.load_index || ''}
                                onChange={(e) => setExtractedSpecs({ ...extractedSpecs, load_index: e.target.value })}
                                className="bg-glass-dark border border-glass rounded-lg px-1.5 py-1 text-xs text-white focus:outline-none focus:border-primary w-1/2 text-center"
                              />
                              <input
                                type="text"
                                placeholder="SR"
                                value={extractedSpecs.speed_rating || ''}
                                onChange={(e) => setExtractedSpecs({ ...extractedSpecs, speed_rating: e.target.value })}
                                className="bg-glass-dark border border-glass rounded-lg px-1.5 py-1 text-xs text-white focus:outline-none focus:border-primary w-1/2 text-center"
                              />
                            </div>
                          </div>
                          <div>
                            <span className="spec-grid__label">Load Range</span>
                            <input
                              type="text"
                              value={extractedSpecs.load_range || ''}
                              onChange={(e) => setExtractedSpecs({ ...extractedSpecs, load_range: e.target.value })}
                              className="bg-glass-dark border border-glass rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-primary w-full mt-1"
                            />
                          </div>
                          <div>
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
                              className="bg-glass-dark border border-glass rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-primary w-full mt-1"
                            >
                              <option value="All-Season">All-Season</option>
                              <option value="Winter">Winter</option>
                              <option value="Summer">Summer</option>
                              <option value="All-Terrain">All-Terrain</option>
                            </select>
                          </div>
                          <div>
                            <span className="spec-grid__label">Ply Rating</span>
                            <input
                              type="text"
                              value={extractedSpecs.ply_rating || ''}
                              onChange={(e) => setExtractedSpecs({ ...extractedSpecs, ply_rating: e.target.value })}
                              className="bg-glass-dark border border-glass rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-primary w-full mt-1"
                            />
                          </div>
                          <div>
                            <span className="spec-grid__label">DOT Code</span>
                            <input
                              type="text"
                              value={extractedSpecs.dot_code || ''}
                              onChange={(e) => setExtractedSpecs({ ...extractedSpecs, dot_code: e.target.value })}
                              className="bg-glass-dark border border-glass rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-primary w-full mt-1"
                            />
                          </div>
                          <div className="col-span-2">
                            <span className="spec-grid__label">UTQG Rating</span>
                            <input
                              type="text"
                              value={extractedSpecs.utqg || ''}
                              onChange={(e) => setExtractedSpecs({ ...extractedSpecs, utqg: e.target.value })}
                              className="bg-glass-dark border border-glass rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-primary w-full mt-1"
                            />
                          </div>
                        </>
                      )}
                    </div>       </div>

                    <WinterApprovedToggle
                      enabled={winterApproved}
                      onChange={setWinterApproved}
                      aiDetected={winterApprovedAiDetected}
                    />
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
                      disabled={savingReceive || !quantityInput}
                      className="w-full btn-primary py-4"
                    >
                      {savingReceive ? <RotateCw className="w-5 h-5 animate-spin" /> : <CheckCircle className="w-5 h-5" />}
                      {skuExists ? 'Confirm & Add to Stock' : 'Create New Product & Initialize Stock'}
                    </button>
                    </div>
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
