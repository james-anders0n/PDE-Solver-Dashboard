FROM python:3.12-slim-bookworm AS runtime

LABEL org.opencontainers.image.title="PDE Studio economic-forecast sidecar" \
      org.opencontainers.image.description="Point-in-time CPI forecast orchestration and accepted snapshot serving"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8020 \
    ECONOMIC_FORECAST_SNAPSHOT_DIR=/var/lib/economic-forecast/snapshots \
    ECONOMIC_FORECAST_CONFIG_PATH=/run/secrets/forecast_config

WORKDIR /opt/economic-forecast

RUN groupadd --system --gid 10001 forecast \
    && useradd --system --uid 10001 --gid forecast --home-dir /opt/economic-forecast forecast \
    && mkdir -p /var/lib/economic-forecast/snapshots \
    && chown -R forecast:forecast /var/lib/economic-forecast /opt/economic-forecast

COPY ["services/economic-forecast/requirements.txt", "/tmp/sidecar-requirements.txt"]
COPY ["Economic Data Prediction Model", "/tmp/economic-model"]
RUN python -m pip install --no-cache-dir -r /tmp/sidecar-requirements.txt \
    && python -m pip install --no-cache-dir /tmp/economic-model \
    && rm -rf /tmp/economic-model /tmp/sidecar-requirements.txt

COPY --chown=forecast:forecast ["services/economic-forecast", "/opt/economic-forecast"]

USER 10001:10001
EXPOSE 8020
VOLUME ["/var/lib/economic-forecast"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8020/ready', timeout=4).read()"]

ENTRYPOINT ["python", "server.py"]
