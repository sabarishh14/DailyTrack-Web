import { API } from '../../constants';
import { getToken, fmt, formatDate } from '../../utils';
import { useAccess } from '../../access/AccessContext';

export default function TransactionDetailsModal({
  actionMenuTx,
  setActionMenuTx,
  setEditingTx,
  setCopyingTx,
  handleDelete,
  setSplitOverrides,
  onRefresh,
}) {
  const canEdit = useAccess().can('money', 'edit');
  if (!actionMenuTx) return null;

  return (
    <div className="modal-backdrop" onClick={() => setActionMenuTx(null)}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ padding: 0, maxWidth: '400px' }}>

        {/* Header / Info Row */}
        <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.2rem', color: 'var(--text)' }}>{actionMenuTx.heading}</h3>
              <p style={{ margin: '4px 0 0 0', fontSize: '0.85rem', color: 'var(--text3)' }}>{formatDate(actionMenuTx.date)} • {actionMenuTx.account}</p>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span className={actionMenuTx.type === 'Credit' ? 'pos' : actionMenuTx.type === 'Investment' ? 'blue-text' : actionMenuTx.type === 'Savings' ? 'accent' : 'neg'} style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>
                {actionMenuTx.type === 'Credit' ? '+' : '-'}{fmt(actionMenuTx.amount)}
              </span>
              <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text2)', marginTop: '2px' }}>{actionMenuTx.type}</span>
            </div>
          </div>
        </div>

        {/* Full Note / Description Box */}
        {actionMenuTx.description && (
          <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.02)' }}>
            <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text)', fontStyle: 'italic', lineHeight: 1.5 }}>
              📝 {actionMenuTx.description}
            </p>
          </div>
        )}

        {/* Split Details UI */}
        {actionMenuTx.split && (
          <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)', maxHeight: '200px', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <div style={{ fontSize: '0.95rem', color: 'var(--text)', fontWeight: 600 }}>👥 Split Details</div>
              <div style={{ fontSize: '0.85rem', color: 'var(--accent)', fontWeight: 600 }}>Total: ₹{actionMenuTx.split.total_amount}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {actionMenuTx.split.members.map((m, idx) => (
                <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', background: 'var(--bg3)', borderRadius: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <input
                      type="checkbox"
                      checked={m.paid}
                      disabled={!canEdit}
                      style={{ cursor: canEdit ? 'pointer' : 'default', width: '16px', height: '16px', accentColor: 'var(--accent)' }}
                      onChange={(e) => {
                        e.stopPropagation();
                        const newMembers = [...actionMenuTx.split.members];
                        newMembers[idx] = { ...newMembers[idx], paid: !newMembers[idx].paid };

                        let myAmount = 0;
                        const youMember = newMembers.find(m => m.name.toLowerCase() === 'you');
                        if (youMember) myAmount += parseFloat(youMember.amount) || 0;
                        myAmount += newMembers.filter(m => m.name.toLowerCase() !== 'you' && !m.paid).reduce((sum, m) => sum + (parseFloat(m.amount) || 0), 0);
                        const finalAmount = myAmount > 0 ? Math.round(myAmount) : actionMenuTx.amount;

                        const updatedTx = { ...actionMenuTx, amount: finalAmount, split: { ...actionMenuTx.split, members: newMembers } };
                        setActionMenuTx(updatedTx);
                        // Also update optimistic overrides for the splits section
                        setSplitOverrides(prev => ({ ...prev, [actionMenuTx.id]: { ...actionMenuTx.split, members: newMembers } }));

                        // Fire API in background
                        fetch(`${API}/splits`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
                          body: JSON.stringify({ transaction_id: updatedTx.id, total_amount: updatedTx.split.total_amount, members: newMembers, transaction_amount: finalAmount })
                        }).catch(err => {
                          alert("Error updating split: " + err.message);
                          setActionMenuTx(actionMenuTx);
                        });
                      }}
                    />
                    <span style={{ fontSize: '0.85rem', color: m.paid ? 'var(--text3)' : 'var(--text)', textDecoration: m.paid ? 'line-through' : 'none' }}>{m.name}</span>
                  </div>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: m.paid ? 'var(--text3)' : 'var(--text)', textDecoration: m.paid ? 'line-through' : 'none' }}>₹{m.amount}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Quick Exclude Toggle */}
        {canEdit && (
        <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: '0.95rem', color: 'var(--text)', fontWeight: 600 }}>Spending Analyser</div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text2)', marginTop: '2px' }}>Include this transaction in pie chart & stats</div>
          </div>
          <button
            onClick={async (e) => {
              e.stopPropagation();
              const updatedTx = { ...actionMenuTx, exclude_analytics: !actionMenuTx.exclude_analytics };
              setActionMenuTx(updatedTx); // Optimistic UI update for instant feedback
              try {
                const res = await fetch(`${API}/transactions/${actionMenuTx.id}`, {
                  method: "PUT",
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
                  body: JSON.stringify({ ...updatedTx, amount: parseFloat(updatedTx.amount) }),
                });
                if (res.ok) onRefresh();
              } catch (err) {
                alert("Error updating transaction: " + err.message);
                setActionMenuTx(actionMenuTx); // Revert on network failure
              }
            }}
            style={{
              width: '46px', height: '26px', borderRadius: '13px',
              background: actionMenuTx.exclude_analytics ? 'var(--border2)' : 'var(--pos)',
              position: 'relative', border: 'none', cursor: 'pointer', transition: 'background 0.2s',
              flexShrink: 0
            }}
          >
            <div style={{
              width: '20px', height: '20px', borderRadius: '50%', background: '#fff',
              position: 'absolute', top: '3px',
              left: actionMenuTx.exclude_analytics ? '3px' : '23px',
              transition: 'left 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
              boxShadow: '0 2px 5px rgba(0,0,0,0.2)'
            }} />
          </button>
        </div>
        )}

        {/* Action Buttons */}
        {canEdit && (
        <div style={{ display: 'flex', flexDirection: 'column', padding: '0.5rem' }}>
          <button
            onClick={() => { setEditingTx(actionMenuTx); setActionMenuTx(null); }}
            style={{ background: 'transparent', border: 'none', padding: '1rem', color: 'var(--text)', fontSize: '0.95rem', fontWeight: 600, textAlign: 'left', display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', borderRadius: '8px' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            ✏️ Edit Transaction
          </button>
          <button
            onClick={() => { setCopyingTx(actionMenuTx); setActionMenuTx(null); }}
            style={{ background: 'transparent', border: 'none', padding: '1rem', color: 'var(--text)', fontSize: '0.95rem', fontWeight: 600, textAlign: 'left', display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', borderRadius: '8px' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            📋 Duplicate Transaction
          </button>
          <button
            onClick={() => { handleDelete(actionMenuTx.id); setActionMenuTx(null); }}
            style={{ background: 'transparent', border: 'none', padding: '1rem', color: 'var(--neg)', fontSize: '0.95rem', fontWeight: 600, textAlign: 'left', display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', borderRadius: '8px' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            🗑️ Delete Transaction
          </button>
        </div>
        )}
      </div>
    </div>
  );
}
