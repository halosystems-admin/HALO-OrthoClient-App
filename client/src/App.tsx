import React, { useState, useEffect, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { PatientWorkspace } from './pages/PatientWorkspace';
import { Toast } from './components/Toast';
import { SettingsModal } from './components/SettingsModal';
import { checkAuth, getLoginUrl, logout, fetchAllPatients, warmAndListFiles, createPatient, deletePatient, loadSettings, saveSettings, ApiError, fetchTodayEvents } from './services/api';
import type { Patient, UserSettings, CalendarEvent } from '../../shared/types';
import { LogIn, Loader, X, UserPlus, Calendar, Users, AlertTriangle, Trash2, Monitor } from 'lucide-react';
import { CalendarPage } from './pages/CalendarPage';

const ENABLE_EXPANDED_CALENDAR =
  import.meta.env.VITE_ENABLE_EXPANDED_CALENDAR !== 'false';

export const App = () => {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(
    () => sessionStorage.getItem('halo_selectedPatientId')
  );
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isReady, setIsReady] = useState(false);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [patientToDelete, setPatientToDelete] = useState<Patient | null>(null);

  const [newPatientName, setNewPatientName] = useState("");
  const [newPatientDob, setNewPatientDob] = useState("");
  const [newPatientSex, setNewPatientSex] = useState<'M' | 'F'>('M');

  // Settings / profile state
  const [showSettings, setShowSettings] = useState(false);
  const [userSettings, setUserSettings] = useState<UserSettings | null>(null);
  const [userEmail, setUserEmail] = useState<string | undefined>();
  const [loginTime] = useState<number>(Date.now());

  // Toast notification state
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Recently opened patients (stored in localStorage)
  const [recentPatientIds, setRecentPatientIds] = useState<string[]>(
    () => {
      try {
        return JSON.parse(localStorage.getItem('halo_recentPatientIds') || '[]');
      } catch { return []; }
    }
  );

  // Calendar / bookings
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarPrepEvent, setCalendarPrepEvent] = useState<CalendarEvent | null>(null);
  const [activeMainView, setActiveMainView] = useState<'workspace' | 'calendar'>('workspace');
  const [screenRest, setScreenRest] = useState(false);

  // Persist selected patient to sessionStorage so it survives page refresh
  // Also track recently opened patients in localStorage
  const selectPatient = useCallback((id: string | null) => {
    setSelectedPatientId(id);
    if (id) {
      sessionStorage.setItem('halo_selectedPatientId', id);
      // Push to recent list (most recent first, deduped, max 3)
      setRecentPatientIds(prev => {
        const updated = [id, ...prev.filter(pid => pid !== id)].slice(0, 3);
        localStorage.setItem('halo_recentPatientIds', JSON.stringify(updated));
        return updated;
      });
    } else {
      sessionStorage.removeItem('halo_selectedPatientId');
    }
  }, []);

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
  }, []);

  const getErrorMessage = (err: unknown): string => {
    if (err instanceof ApiError) return err.message;
    if (err instanceof Error) return err.message;
    return 'An unexpected error occurred.';
  };

  const refreshPatients = useCallback(async (): Promise<Patient[]> => {
    const data = await fetchAllPatients();
    setPatients(data);
    return data;
  }, []);

  // Check if user has an active session
  useEffect(() => {
    const checkSession = async () => {
      try {
        // First verify server is reachable
        const healthCheck = await fetch('/api/health', { credentials: 'include' }).catch(() => null);
        if (!healthCheck || !healthCheck.ok) {
          console.warn('Server health check failed - make sure server is running on port 3000');
        }
        
        const auth = await checkAuth();
        if (auth.signedIn) {
          setIsSignedIn(true);
          setUserEmail(auth.email);
          const loadedPatients = await refreshPatients();
          // Validate stored patient selection — clear if patient no longer exists
          const storedId = sessionStorage.getItem('halo_selectedPatientId');
          if (storedId && !loadedPatients.find(p => p.id === storedId)) {
            selectPatient(null);
          }
          // Prefetch file list for the patient most likely to be opened (warms Drive + server cache)
          const prefetchId = storedId && loadedPatients.some(p => p.id === storedId)
            ? storedId
            : loadedPatients[0]?.id;
          if (prefetchId) {
            warmAndListFiles(prefetchId, 24).catch(() => {});
          }
          // Load settings in background and cache home screen image for next load
          loadSettings().then(res => {
            if (res.settings) {
              setUserSettings(res.settings);
              try {
                if (res.settings.homeScreenImageUrl) {
                  localStorage.setItem('halo_homeScreenImageUrl', res.settings.homeScreenImageUrl);
                }
              } catch {
                /* ignore */
              }
            }
          }).catch(() => {});

          // Load today\u2019s calendar events in background
          setCalendarLoading(true);
          fetchTodayEvents()
            .then(({ events }) => {
              // Best-effort name match here so sidebar calendar gets patientId
              const normalize = (name: string) => name.trim().toLowerCase();
              const mapped = events.map((ev) => {
                const title = ev.title?.trim().toLowerCase() || '';
                let patientId: string | undefined;
                if (title) {
                  const byExact = loadedPatients.find(p => normalize(p.name) === title);
                  if (byExact) {
                    patientId = byExact.id;
                  } else if (title.includes(',')) {
                    const [last, first] = title.split(',').map(s => s.trim());
                    const reordered = `${first} ${last}`.toLowerCase();
                    const byReordered = loadedPatients.find(p => normalize(p.name) === reordered);
                    if (byReordered) patientId = byReordered.id;
                  }
                }
                return { ...ev, patientId };
              });
              setCalendarEvents(mapped);
            })
            .catch(() => {
              setCalendarEvents([]);
            })
            .finally(() => setCalendarLoading(false));
        }
      } catch (error) {
        console.error('Session check failed:', error);
      }
      setIsReady(true);
    };
    checkSession();
  }, []);

  const handleSignIn = async () => {
    setLoading(true);
    try {
      console.log('Fetching login URL...');
      const { url } = await getLoginUrl();
      console.log('Got login URL:', url);
      if (url) {
        window.location.href = url;
      } else {
        throw new Error('No login URL received from server');
      }
    } catch (error) {
      console.error('Sign in error:', error);
      showToast(getErrorMessage(error), 'error');
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    setIsSignedIn(false);
    selectPatient(null);
    setActiveMainView('workspace');
  };

  const openCreateModal = () => {
    setLoading(false);
    setShowCreateModal(true);
  };

  const submitCreatePatient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPatientName.trim()) return;

    setLoading(true);
    try {
      const newP = await createPatient(newPatientName, newPatientDob, newPatientSex);
      if (newP) {
        await refreshPatients();
        setShowCreateModal(false);
        setNewPatientName("");
        setNewPatientDob("");
        setNewPatientSex("M");
        showToast('Patient folder created successfully.', 'success');
      }
    } catch (error) {
      showToast(getErrorMessage(error), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveSettings = async (settings: UserSettings) => {
    await saveSettings(settings);
    setUserSettings(settings);
    try {
      localStorage.setItem('halo_homeScreenImageUrl', settings.homeScreenImageUrl ?? '');
    } catch {
      /* ignore */
    }
    showToast('Settings saved.', 'success');
  };

  const handleDeleteRequest = (patient: Patient) => {
    setPatientToDelete(patient);
  };

  const handleSelectCalendarEvent = (event: CalendarEvent) => {
    if (!event.patientId) return;
    selectPatient(event.patientId);
    setCalendarPrepEvent(event);
    setActiveMainView('workspace');
  };

  const confirmDelete = async () => {
    if (!patientToDelete) return;
    setLoading(true);
    try {
      await deletePatient(patientToDelete.id);
      await refreshPatients();
      if (selectedPatientId === patientToDelete.id) selectPatient(null);
      setPatientToDelete(null);
      showToast('Patient folder moved to trash.', 'success');
    } catch (error) {
      showToast(getErrorMessage(error), 'error');
    } finally {
      setLoading(false);
    }
  };

  if (!isReady) {
    const loadingBgImage = (typeof localStorage !== 'undefined' && localStorage.getItem('halo_homeScreenImageUrl')) || undefined;
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-50 relative overflow-hidden">
        {loadingBgImage && (
          <>
            <div
              className="absolute inset-0 min-h-full min-w-full bg-cover bg-center bg-no-repeat"
              style={{ backgroundImage: `url(${loadingBgImage})` }}
              aria-hidden="true"
            />
            <div className="absolute inset-0 bg-slate-900/30 pointer-events-none" aria-hidden="true" />
          </>
        )}
        <div className="relative z-10 flex flex-col items-center gap-4">
          <Loader className="animate-spin text-sky-600" size={32} />
          <p className="text-sm text-slate-400 font-medium">Loading HALO...</p>
        </div>
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-white">
        <div className="max-w-sm w-full text-center px-6">
          <img
            src="/halo-medical-logo.png"
            alt="HALO Medical"
            className="w-48 h-auto mx-auto mb-6 select-none"
            draggable={false}
          />
          <h1 className="text-3xl font-bold text-slate-800 mb-2">Welcome to HALO</h1>
          <p className="text-slate-500 mb-8 leading-relaxed">Sign in to access your Secure Patient Drive.</p>

          <button onClick={handleSignIn} className="w-full flex items-center justify-center gap-3 bg-sky-600 hover:bg-sky-700 text-white px-6 py-4 rounded-xl transition-all shadow-md hover:shadow-lg font-semibold text-lg active:scale-[0.98]">
            {loading ? <Loader className="animate-spin" /> : <LogIn size={20} />}
            {loading ? "Connecting..." : "Sign In with Google"}
          </button>

          <p className="mt-8 text-xs text-slate-400">Secure Environment &bull; POPIA Compliant</p>
        </div>
      </div>
    );
  }

  const activePatient = patients.find(p => p.id === selectedPatientId);

  return (
    <div className="flex h-screen bg-slate-50 font-sans text-slate-900 overflow-hidden relative">
      <div className={`${selectedPatientId ? 'hidden md:flex' : 'flex'} h-full shrink-0 z-20`}>
        <Sidebar
          patients={patients}
          selectedPatientId={selectedPatientId}
          recentPatientIds={recentPatientIds}
          onSelectPatient={selectPatient}
          onCreatePatient={openCreateModal}
          onDeletePatient={handleDeleteRequest}
          onLogout={handleLogout}
          onOpenSettings={() => setShowSettings(true)}
          onRestScreen={() => setScreenRest(true)}
          userEmail={userEmail}
          userSettings={userSettings}
          hasHomeScreenImage={!!(userSettings?.homeScreenImageUrl || (typeof localStorage !== 'undefined' && localStorage.getItem('halo_homeScreenImageUrl')))}
          calendarEvents={calendarEvents}
          calendarLoading={calendarLoading}
          onSelectCalendarEvent={handleSelectCalendarEvent}
          onOpenFullCalendar={
            ENABLE_EXPANDED_CALENDAR ? () => setActiveMainView('calendar') : undefined
          }
        />
      </div>

      <div className="flex-1 flex flex-col h-screen relative min-w-0">
        {ENABLE_EXPANDED_CALENDAR && activeMainView === 'calendar' ? (
          <CalendarPage
            patients={patients}
            onSelectPatientFromEvent={(id) => {
              selectPatient(id);
              setActiveMainView('workspace');
            }}
            onClose={() => setActiveMainView('workspace')}
          />
        ) : activePatient ? (
          <PatientWorkspace
            key={activePatient.id}
            patient={activePatient}
            onBack={() => selectPatient(null)}
            onDataChange={refreshPatients}
            onToast={showToast}
            templateId={userSettings?.templateId || 'clinical_note'}
            letterheadDriveFileId={userSettings?.letterheadDriveFileId}
            calendarPrepEvent={
              calendarPrepEvent && calendarPrepEvent.patientId === activePatient.id
                ? calendarPrepEvent
                : null
            }
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-300 relative overflow-hidden min-h-0 w-full">
            {/* Custom home screen image (from settings or localStorage cache) or default background */}
            {(() => {
              const homeImageUrl = userSettings?.homeScreenImageUrl
                || (typeof localStorage !== 'undefined' ? localStorage.getItem('halo_homeScreenImageUrl') : null);
              return homeImageUrl ? (
                <div
                  className="absolute inset-0 min-h-full min-w-full bg-cover bg-center bg-no-repeat"
                  style={{ backgroundImage: `url(${homeImageUrl})` }}
                  aria-hidden="true"
                />
              ) : (
                <img
                  src="/halo-logo.png"
                  alt=""
                  aria-hidden="true"
                  className="absolute opacity-[0.04] pointer-events-none select-none w-[70vw] max-w-[700px] min-w-[300px] md:w-[55vw] lg:w-[45vw]"
                  draggable={false}
                />
              );
            })()}
            {/* Overlay so text stays readable on custom image */}
            {(userSettings?.homeScreenImageUrl || (typeof localStorage !== 'undefined' && localStorage.getItem('halo_homeScreenImageUrl'))) && (
              <div className="absolute inset-0 bg-slate-900/40 pointer-events-none" aria-hidden="true" />
            )}
            {/* Foreground content */}
            <div className="relative z-10 flex flex-col items-center text-center px-6">
              <img
                src="/halo-logo.png"
                alt="HALO Medical"
                className="w-44 h-44 md:w-56 md:h-56 lg:w-64 lg:h-64 object-contain mb-6 opacity-20"
                draggable={false}
              />
              <p className="text-lg font-medium text-slate-400">Select a patient to begin</p>
              {(userSettings?.homeScreenImageUrl || (typeof localStorage !== 'undefined' && localStorage.getItem('halo_homeScreenImageUrl'))) && (
                <button
                  type="button"
                  onClick={() => setScreenRest(true)}
                  className="mt-6 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-600 bg-slate-800/60 text-slate-300 hover:bg-slate-700/80 hover:text-white transition-colors text-sm font-medium"
                  title="Show your image full screen (tap anywhere to exit)"
                >
                  <Monitor size={18} /> Rest screen
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Screen rest overlay — full-screen image, tap to exit */}
      {screenRest && (
        <button
          type="button"
          className="fixed inset-0 z-[100] w-full h-full cursor-default focus:outline-none focus:ring-0"
          onClick={() => setScreenRest(false)}
          aria-label="Exit rest screen"
        >
          {(() => {
            const url = userSettings?.homeScreenImageUrl || (typeof localStorage !== 'undefined' ? localStorage.getItem('halo_homeScreenImageUrl') : null);
            return url ? (
              <div
                className="absolute inset-0 min-h-full min-w-full bg-cover bg-center bg-no-repeat"
                style={{ backgroundImage: `url(${url})` }}
              />
            ) : (
              <div className="absolute inset-0 bg-slate-900" />
            );
          })()}
          <span className="absolute bottom-6 left-0 right-0 text-center text-white/50 text-xs font-medium tracking-wide">
            Tap anywhere to exit
          </span>
        </button>
      )}

      {/* TOAST NOTIFICATIONS */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}

      {/* SETTINGS MODAL */}
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        settings={userSettings}
        onSave={handleSaveSettings}
        userEmail={userEmail}
        loginTime={loginTime}
        onToast={showToast}
      />

      {/* CREATE PATIENT MODAL */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 m-4">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2"><UserPlus className="text-sky-600" size={24}/> New Patient Folder</h2>
              <button onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-slate-600 p-1 rounded-full hover:bg-slate-100 transition"><X size={20} /></button>
            </div>
            <form onSubmit={submitCreatePatient}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-semibold text-slate-600 mb-1.5">Full Name</label>
                  <input autoFocus type="text" placeholder="e.g. Sarah Connor" value={newPatientName} onChange={(e) => setNewPatientName(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-slate-200 bg-white text-slate-800 focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none transition" />
                </div>
                <div className="flex gap-4">
                  <div className="flex-1">
                    <label className="block text-sm font-semibold text-slate-600 mb-1.5 flex items-center gap-1"><Calendar size={14} /> Date of Birth</label>
                    <input type="date" value={newPatientDob} onChange={(e) => setNewPatientDob(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-slate-200 bg-white text-slate-800 focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none transition" />
                  </div>
                  <div className="w-1/3">
                    <label className="block text-sm font-semibold text-slate-600 mb-1.5 flex items-center gap-1"><Users size={14} /> Sex</label>
                    <div className="flex bg-slate-100 p-1 rounded-xl">
                      <button type="button" onClick={() => setNewPatientSex('M')} className={`flex-1 py-2 rounded-lg text-sm font-bold transition-all ${newPatientSex === 'M' ? 'bg-white text-sky-700 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>M</button>
                      <button type="button" onClick={() => setNewPatientSex('F')} className={`flex-1 py-2 rounded-lg text-sm font-bold transition-all ${newPatientSex === 'F' ? 'bg-white text-sky-700 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>F</button>
                    </div>
                  </div>
                </div>
                <div className="pt-2 flex gap-3">
                  <button type="button" onClick={() => setShowCreateModal(false)} className="flex-1 px-4 py-3 rounded-xl font-medium text-slate-600 hover:bg-slate-100 transition">Cancel</button>
                  <button type="submit" disabled={!newPatientName.trim() || loading} className="flex-1 bg-sky-600 hover:bg-sky-700 text-white px-4 py-3 rounded-xl font-bold shadow-lg shadow-sky-600/20 disabled:opacity-50 disabled:shadow-none transition flex items-center justify-center gap-2">
                    {loading ? <Loader className="animate-spin" size={18}/> : 'Create Folder'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DELETE CONFIRMATION MODAL */}
      {patientToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 m-4 border-2 border-rose-100">
            <div className="flex flex-col items-center text-center mb-6">
              <div className="w-16 h-16 bg-rose-50 rounded-full flex items-center justify-center mb-4 text-rose-500">
                <AlertTriangle size={32} />
              </div>
              <h2 className="text-xl font-bold text-slate-800">Delete Patient Folder?</h2>
              <p className="text-slate-500 mt-2 px-4">
                Are you sure you want to delete <span className="font-bold text-slate-800">{patientToDelete.name}</span>?
                This will move the folder to your Google Drive Trash.
              </p>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setPatientToDelete(null)} className="flex-1 px-4 py-3 rounded-xl font-bold text-slate-600 hover:bg-slate-100 transition">Cancel</button>
              <button onClick={confirmDelete} className="flex-1 bg-rose-500 hover:bg-rose-600 text-white px-4 py-3 rounded-xl font-bold shadow-lg shadow-rose-500/20 transition flex items-center justify-center gap-2">
                {loading ? <Loader className="animate-spin" size={18}/> : <Trash2 size={18}/>}
                Delete Folder
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
