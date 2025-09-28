FROM ubuntu:22.04

RUN apt-get update 
RUN apt-get install -y curl git

# COPY noir_install.sh /noir_install.sh
# RUN chmod +x /noir_install.sh
# RUN /noir_install.sh

RUN curl -L https://raw.githubusercontent.com/noir-lang/noirup/refs/heads/main/install | bash
RUN /root/.nargo/bin/noirup

# Set up working directory for Noir packages
WORKDIR /workspace

# Add nargo to PATH for easier access
ENV PATH="/root/.nargo/bin:${PATH}"

ENTRYPOINT ["/root/.nargo/bin/nargo"]
