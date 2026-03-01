python3 -m venv .venv


source .venv/bin/activate



python app/testing/gen_panorama_ip_named.py --out test_config.xml --size-mb 25 --base-network 10.0.0.0/8


python app/testing/gen_panorama_ip_named.py --out test_config.xml --size-mb 25 --base-network 10.0.0.0/8 --max-addrs 50000