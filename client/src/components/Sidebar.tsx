import React, { useState, useEffect, useRef } from 'react';
import type { Patient, UserSettings, CalendarEvent } from '../../../shared/types';
import { Plus, LogOut, Search, Trash2, ChevronRight, Users, Clock, Settings, Loader2, Calendar as CalendarIcon, Monitor } from 'lucide-react';
import { searchPatientsByConcept } from '../services/api';
import { SidebarCalendar } from './SidebarCalendar';

interface SidebarProps {
  patients: Patient[];
  selectedPatientId: string | null;
  recentPatientIds: string[];
  onSelectPatient: (id: string) => void;
  onCreatePatient: () => void;
  onDeletePatient: (patient: Patient) => void;
  onLogout: () => void;
  onOpenSettings: () => void;
  onRestScreen?: () => void;
  hasHomeScreenImage?: boolean;
  userEmail?: string;
  userSettings?: UserSettings | null;
  calendarEvents?: CalendarEvent[];
  calendarLoading?: boolean;
  onSelectCalendarEvent?: (event: CalendarEvent) => void;
  onOpenFullCalendar?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  patients,
  selectedPatientId,
  recentPatientIds,
  onSelectPatient,
  onCreatePatient,
  onDeletePatient,
  onLogout,
  onOpenSettings,
  onRestScreen,
  hasHomeScreenImage,
  userEmail,
  userSettings,
  calendarEvents = [],
  calendarLoading = false,
  onSelectCalendarEvent,
  onOpenFullCalendar,
}) => {
  const [searchTerm, setSearchTerm] = useState("");
  const [aiSearchResults, setAiSearchResults] = useState<string[] | null>(null);
  const [isAiSearching, setIsAiSearching] = useState(false);
  const [activeTab, setActiveTab] = useState<'patients' | 'calendar'>('patients');
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Local filter (instant)
  const localFiltered = patients.filter(p =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.dob.includes(searchTerm)
  );

  // Trigger AI concept search after debounce when local results are few (patients tab only)
  useEffect(() => {
    if (activeTab !== 'patients') return;
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    setAiSearchResults(null);

    if (!searchTerm.trim() || searchTerm.length < 3) return;

    // Only trigger AI search if local results are sparse (concept search)
    if (localFiltered.length <= 2) {
      searchTimeoutRef.current = setTimeout(async () => {
        setIsAiSearching(true);
        try {
          const ids = await searchPatientsByConcept(searchTerm, patients, {});
          setAiSearchResults(ids);
        } catch {
          setAiSearchResults(null);
        }
        setIsAiSearching(false);
      }, 600);
    }

    return () => { if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current); };
  }, [searchTerm, patients, activeTab]);

  // Merge local + AI results
  const filteredPatients = searchTerm.trim()
    ? patients.filter(p => {
        const localMatch = p.name.toLowerCase().includes(searchTerm.toLowerCase()) || p.dob.includes(searchTerm);
        const aiMatch = aiSearchResults?.includes(p.id) ?? false;
        return localMatch || aiMatch;
      })
    : patients;

  // Show recently opened patients (by tracked IDs), falling back to first 3 if no history
  const recentPatients = recentPatientIds.length > 0
    ? recentPatientIds
        .map(id => patients.find(p => p.id === id))
        .filter((p): p is Patient => !!p)
        .slice(0, 3)
    : patients.slice(0, 3);

  const renderPatientRow = (patient: Patient, keyPrefix: string) => (
    <div
      key={`${keyPrefix}-${patient.id}`}
      onClick={() => onSelectPatient(patient.id)}
      className={`group flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all border border-transparent mb-1 ${
        selectedPatientId === patient.id
          ? 'bg-sky-600/10 border-sky-500/30 text-sky-400 shadow-sm'
          : 'hover:bg-slate-800 hover:border-slate-700/50 hover:text-slate-100'
      }`}
    >
      <div className="flex items-center gap-3 overflow-hidden">
        <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold ${
          selectedPatientId === patient.id ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-400 group-hover:bg-slate-700 group-hover:text-white'
        }`}>
          {patient.name.charAt(0)}
        </div>
        <div className="min-w-0">
          <p className="font-medium truncate">{patient.name}</p>
          <p className="text-xs opacity-60 truncate">{patient.dob} • {patient.sex}</p>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={(e) => { e.stopPropagation(); if (onDeletePatient) onDeletePatient(patient); }}
          className="p-2 rounded-lg opacity-0 group-hover:opacity-100 transition-all duration-200 hover:bg-rose-500/20 hover:text-rose-400 text-slate-500"
          title="Delete Folder"
        >
          <Trash2 size={16} />
        </button>
        <ChevronRight size={16} className={`opacity-0 group-hover:opacity-100 transition-opacity ${
          selectedPatientId === patient.id ? 'opacity-100' : ''
        }`} />
      </div>
    </div>
  );

  return (
    <div className="w-80 bg-slate-900 h-full flex flex-col text-slate-300 border-r border-slate-800 shadow-2xl">
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl overflow-hidden shadow-lg shadow-sky-900/20">
              <img src="/halo-icon.png" alt="HALO" className="w-full h-full object-cover" draggable={false} />
            </div>
            <div>
              <h1 className="font-bold text-white text-lg tracking-tight">HALO</h1>
              <p className="text-xs text-sky-500 font-bold tracking-wider">PATIENT DRIVE</p>
            </div>
          </div>
          <button
            onClick={onOpenSettings}
            className="p-2 rounded-lg text-slate-500 hover:text-sky-400 hover:bg-slate-800 transition-all"
            title="Settings & Profile"
          >
            <Settings size={20} />
          </button>
        </div>
        <div className="flex items-center justify-between mb-3">
          <div className="relative group flex-1 mr-2">
            {activeTab === 'patients' && (
              <>
                <Search className="absolute left-3 top-3 text-slate-500 group-focus-within:text-sky-400 transition-colors" size={18} />
                <input
                  type="text"
                  placeholder="Search name, DOB, or condition..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full bg-slate-800/50 focus:bg-slate-800 text-sm pl-10 pr-4 py-2.5 rounded-xl outline-none focus:ring-2 focus:ring-sky-500/50 border border-transparent focus:border-sky-500/30 transition-all placeholder:text-slate-600"
                />
              </>
            )}
          </div>
          <div className="flex rounded-xl bg-slate-800/70 border border-slate-700 overflow-hidden shrink-0">
            <button
              type="button"
              onClick={() => setActiveTab('patients')}
              className={`px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
                activeTab === 'patients'
                  ? 'bg-sky-600 text-white'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Patients
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('calendar')}
              className={`px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider flex items-center gap-1 transition-colors ${
                activeTab === 'calendar'
                  ? 'bg-sky-600 text-white'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              <CalendarIcon size={12} />
              Day
            </button>
          </div>
        </div>
        {activeTab === 'patients' && isAiSearching && searchTerm.length >= 3 && (
          <div className="flex items-center gap-2 mt-1 px-1">
            <Loader2 size={12} className="text-sky-500 animate-spin" />
            <span className="text-[10px] text-sky-500 font-medium uppercase tracking-wider">Scanning patient records...</span>
          </div>
        )}
      </div>

      {activeTab === 'calendar' ? (
        <div className="flex-1 flex flex-col">
          <div className="px-4 pb-2">
            <button
              type="button"
              onClick={onOpenFullCalendar}
              className="w-full text-xs font-semibold text-slate-300 bg-slate-800/70 hover:bg-slate-700 border border-slate-700/80 rounded-xl px-3 py-2 flex items-center justify-center gap-2 transition-colors"
            >
              <CalendarIcon size={12} />
              Open full calendar
            </button>
          </div>
          <SidebarCalendar
            events={calendarEvents}
            patients={patients}
            loading={calendarLoading}
            onSelectEvent={(ev) => onSelectCalendarEvent && onSelectCalendarEvent(ev)}
          />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 custom-scrollbar">
          {!searchTerm && patients.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center gap-2 px-2 mb-2">
              <Clock size={12} className="text-sky-500"/>
              <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Recent Activity</h3>
            </div>
            {recentPatients.map(p => renderPatientRow(p, 'recent'))}
            <div className="my-4 border-t border-slate-800/50 mx-2"></div>
          </div>
        )}
        <div>
          <div className="flex items-center gap-2 px-2 mb-2">
            <Users size={12} className={searchTerm ? "text-sky-500" : "text-slate-500"}/>
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              {searchTerm ? 'Search Results' : 'All Patients'}
              <span className="ml-1 opacity-60">({filteredPatients.length})</span>
            </h3>
          </div>
          {filteredPatients.length === 0 ? (
            <div className="text-center py-8 opacity-40"><p className="text-sm">No patients found</p></div>
          ) : (
            filteredPatients.map(p => renderPatientRow(p, 'all'))
          )}
          </div>
        </div>
      )}

      <div className="p-4 border-t border-slate-800 bg-slate-900/50 backdrop-blur-sm z-10">
        <button onClick={onCreatePatient} className="w-full bg-sky-600 hover:bg-sky-500 text-white p-3.5 rounded-xl font-bold transition-all shadow-lg shadow-sky-900/20 flex items-center justify-center gap-2 mb-3 active:scale-[0.98]">
          <Plus size={20} /> New Patient Folder
        </button>
        {hasHomeScreenImage && onRestScreen && (
          <button
            type="button"
            onClick={onRestScreen}
            className="w-full flex items-center justify-center gap-2 text-xs font-medium text-slate-500 hover:text-slate-300 py-2.5 mb-1 transition-colors"
            title="Show your home image full screen"
          >
            <Monitor size={14} /> Rest screen
          </button>
        )}
        <button onClick={onLogout} className="w-full flex items-center justify-center gap-2 text-xs font-medium text-slate-500 hover:text-slate-300 py-2 transition-colors">
          <LogOut size={14} /> SIGN OUT
        </button>
      </div>
    </div>
  );
};