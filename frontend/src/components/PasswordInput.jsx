import { useState } from 'react';

export default function PasswordInput({ id, value, onChange, placeholder, autoComplete, invalid }) {
  const [show, setShow] = useState(false);
  return (
    <div className="input-group">
      <input
        id={id}
        className={`input${invalid ? ' invalid' : ''}`}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        style={{ paddingRight: 66 }}
      />
      <button type="button" className="reveal" onClick={() => setShow((s) => !s)} tabIndex={-1}>
        {show ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
