export default function Brand({ subtitle = 'PMS & EHR', showSub = true }) {
  return (
    <div className="brand">
      <img src="/Grelin_logo.png" alt="Grelin Health" />
      {showSub && (
        <>
          <span className="divider" />
          <span className="sub">{subtitle}</span>
        </>
      )}
    </div>
  );
}
