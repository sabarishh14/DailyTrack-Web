# 3.11+: casparser (CAS statement import) needs it.
FROM python:3.11-slim

# Create the user first
RUN useradd -m -u 1000 user

# Explicitly create /app and give the user ownership
RUN mkdir -p /app && chown -R user:user /app

WORKDIR /app

# Install dependencies 
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy your actual backend code
COPY --chown=user:user . .

# Hugging Face Spaces require running on port 7860
EXPOSE 7860

# Switch to the non-root user
USER user

# Run the app with Gunicorn
# Note: If your main Python file is named something other than app.py, change "app:app" to "filename:app"
CMD ["gunicorn", "-b", "0.0.0.0:7860", "app:app", "--timeout", "120", "--workers", "4", "--threads", "4", "--preload"]