import { useState } from 'react';
import AddAccountModal from '../pages/settings-components/AddAccountModal';

/** Shown until someone has an account: everything in Money starts from one. */
export default function FirstAccountPrompt({ onAdded }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="first-run">
      <span className="first-run-icon" aria-hidden="true">🏦</span>
      <b>Add your first account</b>
      <span>A bank account or a credit card</span>
      <button className="action-btn" onClick={() => setAdding(true)}>＋ Add account</button>
      {adding && (
        <AddAccountModal
          existingNames={new Set()}
          onClose={() => setAdding(false)}
          onAdded={() => { setAdding(false); onAdded?.(); }}
        />
      )}
    </div>
  );
}
