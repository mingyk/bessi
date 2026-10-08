"use client";

import { useState, type FormEvent } from "react";

const empty = {
  first: "",
  last: "",
  restaurant: "",
  email: "",
  phone: "",
  need: "",
};

export function ContactForm() {
  const [form, setForm] = useState(empty);
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [error, setError] = useState("");

  const update = (key: keyof typeof empty) => (event: { target: { value: string } }) => {
    setForm((current) => ({ ...current, [key]: event.target.value }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setStatus("sending");
    setError("");
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "couldn’t send. try again.");
      }
      setStatus("sent");
      setForm(empty);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "couldn’t send. try again.");
    }
  };

  if (status === "sent") {
    return (
      <div className="form-sent" role="status">
        <p>thanks. we’ll be in touch soon.</p>
        <button type="button" className="text-button" onClick={() => setStatus("idle")}>
          send another
        </button>
      </div>
    );
  }

  return (
    <form className="form" onSubmit={submit}>
      <div className="form-row">
        <label>
          first name
          <input
            name="first"
            autoComplete="given-name"
            required
            value={form.first}
            onChange={update("first")}
          />
        </label>
        <label>
          last name
          <input
            name="last"
            autoComplete="family-name"
            required
            value={form.last}
            onChange={update("last")}
          />
        </label>
      </div>
      <label>
        restaurant
        <input
          name="restaurant"
          autoComplete="organization"
          required
          value={form.restaurant}
          onChange={update("restaurant")}
        />
      </label>
      <div className="form-row">
        <label>
          email
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={update("email")}
          />
        </label>
        <label>
          phone
          <input
            name="phone"
            type="tel"
            autoComplete="tel"
            required
            value={form.phone}
            onChange={update("phone")}
          />
        </label>
      </div>
      <label>
        which calls should she take?
        <textarea
          name="need"
          required
          rows={3}
          placeholder="reservations, the wait list, to-go, after hours…"
          value={form.need}
          onChange={update("need")}
        />
      </label>
      <div className="form-foot">
        <button type="submit" className="button" disabled={status === "sending"}>
          {status === "sending" ? "sending…" : "send"}
        </button>
        <p className="form-error" aria-live="polite">
          {error}
        </p>
      </div>
    </form>
  );
}
