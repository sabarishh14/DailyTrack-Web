export const API = import.meta.env.VITE_API_URL ||
  (window.location.hostname === "localhost"
    ? "http://localhost:5000/api"
    : window.location.origin + "/api");

export const BANKS = {
  KOTAK: { emoji: "🔴", color: "#ef4444" },
  IDBI: { emoji: "🟢", color: "#22c55e" },
  FEDERAL: { emoji: "🟠", color: "#f97316" },
  CUB: { emoji: "🟣", color: "#a855f7" },
  INDIAN: { emoji: "🔵", color: "#3b82f6" },
  ICICI: { emoji: "🟡", color: "#eab308" },
  "CC-PINNACLE 6360": { emoji: "💳", color: "#ec4899" },
  "CC-SBI 0033": { emoji: "💳", color: "#ec4899" },
  "CC-ICICI SAFFIRE": { emoji: "💳", color: "#ec4899" },
  "CC-AP 4004": { emoji: "💳", color: "#ec4899" },
  "CC-SBI 9810": { emoji: "💳", color: "#ec4899" },
  "CC-AXIS REWARDS": { emoji: "💳", color: "#ec4899" },
  "Cash": { emoji: "💵", color: "#10b981" },
};

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const TABS = [
  { id: 0, icon: "🏠", label: "Home" },
  { id: 1, icon: "💰", label: "Money" },
  { id: 2, icon: "➕", label: "Add Transaction", add: true },
  { id: 3, icon: "✅", label: "Routines" },
  { id: 4, icon: "📈", label: "Investments" },
  { id: 5, icon: "📺", label: "SabDekho" },
];

export const TAB_TITLES = ["Dashboard", "Money", "Add Transaction", "Routines", "Investments", "SabDekho"];