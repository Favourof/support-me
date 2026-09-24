import { useState } from 'react'

export default function DonationForm({ onSend, loading }) {
  const [amount, setAmount] = useState('')
  const [memo, setMemo]     = useState('')

  const valid = parseFloat(amount) > 0

  const handleSend = () => {
    if (!valid) return
    onSend({ amount, memo })
  }

  return (
    <div className="flex flex-col gap-4 animate-fade-in">

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-0.5 bg-ink" />
        <span className="text-[11px] font-extrabold uppercase tracking-widest text-ink">
          Send a donation
        </span>
        <div className="flex-1 h-0.5 bg-ink" />
      </div>

      {/* Amount */}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="amount"
          className="text-[12px] font-bold text-ink"
        >
          Amount
        </label>
        <div className="relative">
          <input
            id="amount"
            type="number"
            min="0.0000001"
            step="any"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="0.00"
            className="input-brutal pr-14 text-[15px] font-medium"
          />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[13px] font-extrabold font-mono text-primary pointer-events-none">
            XLM
          </span>
        </div>
      </div>

      {/* Memo */}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="memo"
          className="text-[12px] font-bold text-ink"
        >
          Message{' '}
          <span className="font-medium text-muted">(optional)</span>
        </label>
        <input
          id="memo"
          type="text"
          maxLength={140}
          value={memo}
          onChange={e => setMemo(e.target.value)}
          placeholder="Add a kind note…"
          className="input-brutal text-[15px]"
        />
      </div>

      {/* Send button */}
      <button
        onClick={handleSend}
        disabled={!valid || loading}
        className="btn-brutal btn-brutal-primary w-full py-4 text-[15px]"
      >
        {loading ? (
          <>
            <span className="spinner" />
            <span>Sending…</span>
          </>
        ) : (
          <span>Send Donation</span>
        )}
      </button>

    </div>
  )
}
